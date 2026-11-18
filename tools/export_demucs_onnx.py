"""
Exports the core of Demucs htdemucs to ONNX for RiddimX's built-in stem engine.

The STFT / iSTFT stay outside the model (the app does them in JavaScript): ONNX has no complex numbers.
Inputs:  mix  float32 [1, 2, L]        one segment of the normalised stereo mix (L = 343980, 7.8 s @ 44.1 kHz)
         mag  float32 [1, 4, 2048, T]  its spectrogram, real and imaginary parts as channels (T = 336)
Outputs: spec float32 [1, S, 4, 2048, T]  per source (S = 4 for htdemucs): L re, L im, R re, R im (to be turned back by iSTFT)
         wave float32 [1, S, 2, L]        per source: time-branch waveform (added to the iSTFT result)
Usage: python tools/export_demucs_onnx.py public/models/htdemucs.onnx [model]
       model: htdemucs (default, 4 sources), htdemucs_ft (4 fine-tuned models, one per source, cleaner but
       4x slower: all four go into one ONNX file, each giving only its own source) or htdemucs_6s (6: adds
       guitar and piano; weaker, not used)
"""
import sys

import torch
from demucs.pretrained import get_model


class Core(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.m = model

    def forward(self, mix, mag):
        m = self.m
        x = mag
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)
        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)
        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)
        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)
        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        x = x * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, mix.shape[-1])
        xt = xt * stdt[:, None] + meant[:, None]
        return x, xt


class Bag(torch.nn.Module):
    """Several models, each weighted per source (htdemucs_ft: model k gives source k only)."""

    def __init__(self, models, weights):
        super().__init__()
        self.cores = torch.nn.ModuleList(Core(m) for m in models)
        self.weights = weights

    def forward(self, mix, mag):
        S = len(self.weights[0])
        specs, waves = [], []
        for s in range(S):
            used = [(k, w[s]) for k, w in enumerate(self.weights) if w[s]]
            total = sum(w for _, w in used)
            spec = wave = None
            for k, w in used:
                x, xt = self.cores[k](mix, mag)
                spec = x[:, s] * (w / total) if spec is None else spec + x[:, s] * (w / total)
                wave = xt[:, s] * (w / total) if wave is None else wave + xt[:, s] * (w / total)
            specs.append(spec)
            waves.append(wave)
        return torch.stack(specs, 1), torch.stack(waves, 1)


def main():
    out = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else "htdemucs"
    # The fused attention kernel has no ONNX form: use the plain one.
    torch.backends.mha.set_fastpath_enabled(False)
    bag = get_model(name)
    model = bag.models[0] if hasattr(bag, "models") else bag
    model.eval()
    L = int(model.segment * model.samplerate)
    T = -(-L // model.hop_length)
    models = list(bag.models) if hasattr(bag, "models") else [bag]
    weights = [list(map(float, w)) for w in bag.weights] if hasattr(bag, "weights") else [[1.0] * len(model.sources)]
    for m in models:
        m.eval()
        assert m.segment == model.segment and m.sources == model.sources
    core = (Core(model) if len(models) == 1 else Bag(models, weights)).eval()
    mix = torch.randn(1, 2, L)
    mag = torch.randn(1, 4, model.nfft // 2, T)
    with torch.no_grad():
        torch.onnx.export(core, (mix, mag), out, input_names=["mix", "mag"], output_names=["spec", "wave"], opset_version=17, dynamo=False)
    print("exported", name, list(model.sources), out, "L", L, "T", T)


if __name__ == "__main__":
    main()
