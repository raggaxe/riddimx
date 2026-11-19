# Roadmap

Features parked for later. Each one is kept in the code, switched off, so it can come back without being rebuilt.

## Lyrics on the waveform

Switch: `LYRICS_ON` in `src/engine/lyrics.ts`.

Lines come from the LRCLIB catalogue, or are transcribed on the Mac by whisper.cpp from the vocal stem, then lined up with the singing (global shift and speed, then line by line). Parked in November 2026: on real tracks the timing was still too far off to be useful live.

To bring it back: better alignment (word-level timing from the transcription, forced alignment against the vocal stem), then turn the switch on. The settings section (language, model) and the waveform's earlier / later buttons come back with it.

## Auto dub in the rack

Switch: `AUTO_DUB_ON` in `src/components/Rack.tsx`. The engine (`src/engine/autodub.ts`) still works from the MIDI / keyboard mapping. Hidden in November 2026 to give the Dub Box the whole DUB FX row.

## Third-party VST3 plugins

The Plugin tab has two built-in AUX effects. VST3 would need a native audio host (JUCE or similar) inside the Electron app, with its own code signing and crash isolation.
