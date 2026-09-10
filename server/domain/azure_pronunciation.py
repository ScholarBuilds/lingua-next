"""按次提交的 Azure 短句发音评测，不保存原始录音。"""

import base64
import io
import json
import wave

from domain.azure_speech import endpoint
from domain.network_policy import routed_http_client

MAX_AUDIO_BYTES = 1_000_000


def validate_wav(audio: bytes) -> float:
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise ValueError("录音为空或超过 30 秒限制")
    try:
        with wave.open(io.BytesIO(audio)) as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise ValueError("评测需要 16kHz 单声道 PCM WAV")
            frames = wav.getnframes()
            duration = frames / 16000
            if not 0.4 <= duration <= 30:
                raise ValueError("请录制 0.4～30 秒的短句")
            if len(wav.readframes(frames)) != frames * 2:
                raise ValueError("录音文件不完整")
            return duration
    except (wave.Error, EOFError) as exc:
        raise ValueError("录音不是有效 WAV") from exc


async def assess(config: dict, audio: bytes, text: str) -> dict:
    duration = validate_wav(audio)
    endpoint(config)
    region = config["region"].strip().lower()
    options = {
        "ReferenceText": text,
        "GradingSystem": "HundredMark",
        "Granularity": "Phoneme",
        "Dimension": "Comprehensive",
        "EnableMiscue": True,
    }
    async with routed_http_client(timeout=30) as client:
        response = await client.post(
            f"https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1",
            params={"language": "en-US", "format": "detailed"},
            headers={
                "Ocp-Apim-Subscription-Key": config["api_key"],
                "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
                "Pronunciation-Assessment": base64.b64encode(json.dumps(options).encode()).decode(),
            },
            content=audio,
        )
        response.raise_for_status()
        result = response.json()
    if result.get("RecognitionStatus") != "Success" or not result.get("NBest"):
        raise ValueError("Azure 未识别到完整语音，请靠近麦克风重试")
    best = result["NBest"][0]
    assessment = best.get("PronunciationAssessment", best)
    return {
        "text": best.get("Display", result.get("DisplayText", "")),
        "duration": duration,
        "scores": {
            key: assessment.get(key)
            for key in (
                "PronScore",
                "AccuracyScore",
                "FluencyScore",
                "CompletenessScore",
                "ProsodyScore",
            )
        },
        "words": [
            {
                "word": word.get("Word", ""),
                "accuracy": word.get("PronunciationAssessment", word).get("AccuracyScore"),
                "error": word.get("PronunciationAssessment", word).get("ErrorType"),
                "phonemes": word.get("Phonemes", []),
            }
            for word in best.get("Words", [])
        ],
    }
