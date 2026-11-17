"""
Splits one track into stems with Demucs (htdemucs: drums, bass, other, vocals).

Usage: python stems.py <input.f32> <sample_rate> <out_dir>
  input.f32: raw little-endian float32, interleaved stereo.
Writes <out_dir>/<stem>.wav (16-bit stereo, same sample rate as the input) and prints
"PROGRESS <0..1>" lines on stdout while it works, then "DONE".
"""
import sys
import wave

import numpy as np
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model
import julius


def progress(value: float) -> None:
    print(f"PROGRESS {value:.3f}", flush=True)


def main() -> None:
    source, rate, out_dir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    progress(0)
    audio = np.fromfile(source, dtype="<f4").reshape(-1, 2).T.copy()
    mix = torch.from_numpy(audio)

    model = get_model("htdemucs")
    model.eval()
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model.to(device)
    if rate != model.samplerate:
        mix = julius.resample_frac(mix, rate, model.samplerate)

    # Normalise like Demucs' own command line does, and undo it afterwards.
    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    mix = (mix - mean) / std

    # Work in slices so progress can be reported; each slice is split with overlap inside apply_model.
    total = mix.shape[-1]
    step = model.samplerate * 30
    pad = model.samplerate * 2
    parts = []
    with torch.no_grad():
        for start in range(0, total, step):
            lo, hi = max(0, start - pad), min(total, start + step + pad)
            chunk = mix[:, lo:hi].unsqueeze(0).to(device)
            out = apply_model(model, chunk, split=True, overlap=0.25, shifts=1, progress=False, device=device)[0].cpu()
            parts.append(out[..., start - lo : start - lo + min(step, total - start)])
            progress(min(1.0, (start + step) / total) * 0.97)
    stems = torch.cat(parts, dim=-1) * std + mean

    for index, name in enumerate(model.sources):
        stem = stems[index]
        if rate != model.samplerate:
            stem = julius.resample_frac(stem, model.samplerate, rate)
        pcm = (stem.clamp(-1, 1).numpy().T * 32767).astype("<i2")
        with wave.open(f"{out_dir}/{name}.wav", "wb") as f:
            f.setnchannels(2)
            f.setsampwidth(2)
            f.setframerate(rate)
            f.writeframes(pcm.tobytes())
    progress(1)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
