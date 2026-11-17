"""Compares the ONNX core + numpy STFT against Demucs' own model on one segment of a real track."""
import sys, subprocess
import numpy as np, torch, onnxruntime as ort
from demucs.pretrained import get_model
from demucs.spec import spectro, ispectro
import torch.nn.functional as F

torch.backends.mha.set_fastpath_enabled(False)
bag = get_model("htdemucs"); m = bag.models[0]; m.eval()
L = int(m.segment * m.samplerate)
import wave as _w
# A 32-bit float WAV made by afconvert: read the data chunk by hand (the wave module only reads PCM).
data = open(sys.argv[1], "rb").read()
i = data.index(b"data") + 8
a = np.frombuffer(data[i:], dtype="<f4")
a = a[: a.size // 2 * 2].reshape(-1, 2).T
a = a[:, 44100 * 60: 44100 * 60 + L].copy()
mix = torch.from_numpy(a)[None]
with torch.no_grad():
    ref = m(mix)[0].numpy()  # [4, 2, L]
    z = m._spec(mix); mag = m._magnitude(z)
sess = ort.InferenceSession(sys.argv[2])
spec, wave = sess.run(None, {"mix": mix.numpy(), "mag": mag.numpy()})
x = torch.from_numpy(spec)
zout = m._mask(z, x)
out = (m._ispec(zout, L) + torch.from_numpy(wave))[0].numpy()
err = out - ref
sdr = 10 * np.log10((ref ** 2).sum() / ((err ** 2).sum() + 1e-12))
print("max abs diff", float(np.abs(err).max()), "SDR vs torch (dB)", round(float(sdr), 1))
