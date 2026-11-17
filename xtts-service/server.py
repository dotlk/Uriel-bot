
import asyncio
import hashlib
import os
import re
import tempfile
from collections import OrderedDict
from typing import List

os.environ.setdefault("COQUI_TOS_AGREED", "1")

import numpy as np
import torch
from fastapi import FastAPI, Form, UploadFile, File, HTTPException
from fastapi.responses import Response
from fastapi.concurrency import run_in_threadpool

from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import Xtts
from TTS.utils.manage import ModelManager
from TTS.utils.audio.numpy_transforms import save_wav

app = FastAPI()

MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"
SAMPLE_RATE = 24_000

MAX_TOTAL_CHARS = 250
MAX_CHARS_PER_SEGMENT = 150

# Limites de upload das amostras de referência
MAX_REFERENCE_FILES = 10
MAX_REFERENCE_BYTES = 15 * 1024 * 1024
ALLOWED_REFERENCE_SUFFIXES = {".wav", ".mp3"}

# Quantas vozes guardam os "latents" de condicionamento em memória
CONDITIONING_CACHE_SIZE = 32

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"🔊 Loading XTTS v2 on device: {device}...")

manager = ModelManager()
model_path, config_path, _ = manager.download_model(MODEL_NAME)

config = XttsConfig()
config.load_json(config_path)

tts_model = Xtts.init_from_config(config)
tts_model.load_checkpoint(config, checkpoint_dir=model_path, eval=True)
tts_model.to(device)

print("✅ XTTS v2 loaded and ready!")

SUPPORTED_LANGUAGES = set(getattr(config, "languages", []) or [])

# O modelo roda numa GPU só: várias inferências ao mesmo tempo estouram a VRAM
# ou ficam todas lentas. O lock garante uma síntese por vez.
inference_lock = asyncio.Lock()

# Cache dos latents de condicionamento por voz (chave = hash das amostras).
# Calcular isso é a parte cara de cada requisição e o resultado não muda
# enquanto as amostras da voz forem as mesmas.
conditioning_cache = OrderedDict()

DEFAULT_PRESET = {
    "temperature": 0.75,
    "speed": 1.0,
    "repetition_penalty": 5.0
}

EMOTION_PRESETS = {
    "angry": {
        "temperature": 0.95,
        "speed": 1.15,
        "repetition_penalty": 3.0
    },
    "happy": {
        "temperature": 0.85,
        "speed": 1.08,
        "repetition_penalty": 4.0
    },
    "calm": {
        "temperature": 0.6,
        "speed": 0.9,
        "repetition_penalty": 6.0
    },
    "sad": {
        "temperature": 0.65,
        "speed": 0.85,
        "repetition_penalty": 6.0
    },
    "scared": {
        "temperature": 0.9,
        "speed": 1.1,
        "repetition_penalty": 3.5
    },
    "surprised": {
        "temperature": 0.9,
        "speed": 1.05,
        "repetition_penalty": 4.0
    },
    "neutral": DEFAULT_PRESET,
}

TAG_PATTERN = re.compile(r"\[([^\[\]]{1,40})\]")


def split_text_into_chunks(text: str, max_chars: int):
    """Divide text into chunks, prioritizing sentences and words."""
    if max_chars <= 0:
        raise ValueError("max_chars must be greater than zero.")

    chunks = []
    text = text.strip()

    while text:
        if len(text) <= max_chars:
            chunks.append(text)
            break

        window = text[:max_chars]

        sentence_ends = [
            match.end()
            for match in re.finditer(r"[.!?]+(?=\s|$)", window)
        ]

        if sentence_ends:
            cut = sentence_ends[-1]
        else:
            cut = window.rfind(" ")
            if cut <= 0:
                cut = max_chars

        chunk = text[:cut].strip()

        if chunk:
            chunks.append(chunk)

        text = text[cut:].strip()

    return chunks


def truncate_text_at_word(text: str, max_chars: int):
    """Limits text length without cutting words."""
    if max_chars <= 0:
        return ""

    if len(text) <= max_chars:
        return text

    candidate = text[:max_chars]

    if text[max_chars].isspace():
        return candidate.rstrip()

    last_space = candidate.rfind(" ")

    if last_space >= 0:
        return candidate[:last_space].rstrip()

    return ""


def parse_emotion_segments(raw_text: str):
    """Processes emotion tags and limits spoken text to 250 characters."""
    text = (raw_text or "").strip()

    if not text:
        return []

    segments = []
    remaining = MAX_TOTAL_CHARS
    current_emotion = None
    last_index = 0

    def add_chunk(chunk, emotion):
        nonlocal remaining

        if remaining <= 0:
            return

        chunk = " ".join(chunk.split())

        if not chunk:
            return

        if segments:
            if remaining <= 1:
                return
            remaining -= 1

        chunk = truncate_text_at_word(chunk, remaining)

        if not chunk:
            return

        for part in split_text_into_chunks(chunk, MAX_CHARS_PER_SEGMENT):
            segments.append((emotion, part))

        remaining -= len(chunk)

    for match in TAG_PATTERN.finditer(text):
        if remaining <= 0:
            break

        add_chunk(text[last_index:match.start()], current_emotion)

        if remaining <= 0:
            break

        label = match.group(1).strip().lower()

        if label in EMOTION_PRESETS:
            current_emotion = label
        else:
            add_chunk(match.group(0), current_emotion)

        last_index = match.end()

    if remaining > 0:
        add_chunk(text[last_index:], current_emotion)

    return segments


def compute_conditioning(ref_paths: List[str]):
    return tts_model.get_conditioning_latents(audio_path=ref_paths)


def synthesize_with_emotions(text: str, conditioning, language: str):
    """Synthesizes segments using the same voice conditioning."""
    segments = parse_emotion_segments(text)

    if not segments:
        raise ValueError("Empty text after processing emotion tags.")

    gpt_cond_latent, speaker_embedding = conditioning

    all_wavs = []

    for emotion_label, segment_text in segments:
        preset = EMOTION_PRESETS.get(emotion_label, DEFAULT_PRESET)

        out = tts_model.inference(
            segment_text,
            language,
            gpt_cond_latent,
            speaker_embedding,
            temperature=preset["temperature"],
            speed=preset["speed"],
            repetition_penalty=preset["repetition_penalty"],
        )

        all_wavs.append(np.array(out["wav"]))

    return np.concatenate(all_wavs)


@app.post("/synthesize")
async def synthesize(
    text: str = Form(...),
    language: str = Form("pt"),
    reference_audio: List[UploadFile] = File(...)
):
    if SUPPORTED_LANGUAGES and language not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")

    if len(reference_audio) > MAX_REFERENCE_FILES:
        raise HTTPException(status_code=400, detail="Too many reference files.")

    references = []
    for audio_file in reference_audio:
        data = await audio_file.read(MAX_REFERENCE_BYTES + 1)
        if not data:
            raise HTTPException(status_code=400, detail="Empty reference file.")
        if len(data) > MAX_REFERENCE_BYTES:
            raise HTTPException(status_code=413, detail="Reference file too large.")

        suffix = os.path.splitext(audio_file.filename or "")[1].lower()
        if suffix not in ALLOWED_REFERENCE_SUFFIXES:
            suffix = ".wav"
        references.append((suffix, data))

    cache_key = hashlib.sha256(b"".join(hashlib.sha256(data).digest() for _, data in references)).hexdigest()

    ref_paths = []
    output_path = None

    try:
        async with inference_lock:
            conditioning = conditioning_cache.get(cache_key)

            if conditioning is None:
                # Só grava as amostras em disco quando precisa recalcular os latents
                for suffix, data in references:
                    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as ref_file:
                        ref_file.write(data)
                        ref_paths.append(ref_file.name)

                conditioning = await run_in_threadpool(compute_conditioning, ref_paths)
                conditioning_cache[cache_key] = conditioning

                while len(conditioning_cache) > CONDITIONING_CACHE_SIZE:
                    conditioning_cache.popitem(last=False)
            else:
                conditioning_cache.move_to_end(cache_key)

            try:
                final_wav = await run_in_threadpool(
                    synthesize_with_emotions,
                    text,
                    conditioning,
                    language
                )
            except ValueError as error:
                raise HTTPException(status_code=400, detail=str(error))

        with tempfile.NamedTemporaryFile(suffix="_out.wav", delete=False) as out_file:
            output_path = out_file.name

        save_wav(wav=final_wav, path=output_path, sample_rate=SAMPLE_RATE)

        with open(output_path, "rb") as f:
            audio_bytes = f.read()

        return Response(content=audio_bytes, media_type="audio/wav")

    finally:
        for p in ref_paths + ([output_path] if output_path else []):
            if os.path.exists(p):
                os.remove(p)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "device": device,
        "emotions": list(EMOTION_PRESETS.keys())
    }
