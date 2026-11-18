# Plano: RiddimX no Android (Samsung DeX)

Estado: **só plano, nada começado.** Registado em 2026-11-17.

## Objetivo

Correr a RiddimX completa num telemóvel Android em modo DeX (monitor ou TV), no Chrome, com todos os
recursos de dub e de IA, a controladora MIDI e o comando DualShock 4.

Sem layout de telemóvel: o DeX dá janelas de tamanho de computador, por isso a interface atual serve.

## Decisões tomadas

- **Só DeX** (com monitor/TV), não ecrã do telemóvel.
- **Alojamento: Vercel**, em HTTPS. O Chrome só deixa usar mic, Web MIDI e Gamepad numa origem segura.
  O link fica público: proteger com senha (Vercel password protection ou um portão simples).

## O que já funciona no browser (sem mudanças)

- Decks, mixer, Eco fita, mola, isolador, Dub Box, sirenes, sampler, autodub, drops gravados.
- Mic com a aba Voz (efeitos próprios, THROW).
- DualShock 4 por Bluetooth (Gamepad API, mapa "Comando PlayStation: dub").
- Controladora MIDI pelo Chrome Android (Web MIDI). Com DeX por cabo é preciso hub USB-C
  (HDMI + USB + carga); com DeX sem fios a porta fica livre.
- **Stems**: já correm no browser (Demucs htdemucs em ONNX, 4 faixas, `src/engine/ai/stems.worker.ts`, WebGPU com
  recurso a WASM). No telemóvel: mais lento e o modelo (~166 MB, `/models/htdemucs.onnx`) desce na primeira vez.
- Músicas em ficheiro e Spotify.

## O que depende do Mac hoje (Electron) e o plano para cada

| Recurso | Hoje | No Android |
| --- | --- | --- |
| Letras automáticas | `whisper-cli` nativo (`vx:transcribe`) | Whisper no browser com `@huggingface/transformers` (já em devDependencies), modelo guardado em cache |
| Vozes dos drops (TTS) | `say` do macOS (`vx:speak`) | Modelo TTS no browser (ex.: Kokoro/Piper em ONNX) que devolve áudio, para entrar na mistura com efeitos. `speechSynthesis` não serve: não passa pelo Web Audio |
| Guardar stems e letras | ficheiros no disco (`vx:stems-save`, `vx:lyrics-cached`) | IndexedDB / OPFS no telemóvel |
| Caminho dos ficheiros (`pathOf`, `vx:read-audio`) | disco do Mac | ficheiros escolhidos guardados em OPFS/IndexedDB |
| Permissão do mic (`vx:mic-access`) | TCC do macOS | o próprio Chrome pede |
| **Som do YouTube** (`vx:capture`) | Electron apanha o áudio do webContents | **Impossível no Android.** O vídeo toca, mas sem efeitos, eco nem stems. Não sacar o áudio do YouTube |

## Passos

1. **Publicar na Vercel** (HTTPS, com senha). Build com `vite build`; o `analyzer.html` pode ficar de fora.
   Ver cabeçalhos COOP/COEP se o WASM com threads (`ort-wasm-simd-threaded`) os pedir.
2. **Modo Android/DeX**: detetar que não há `desktop` (Electron), guardar músicas, stems e letras no
   telemóvel, esconder ou explicar o que precisa do Mac (YouTube), afinar o toque nos knobs e faders
   (`touch-action: none`).
3. **Letras no browser** com Whisper (transformers.js), descarregado e guardado.
4. **Vozes TTS no browser** para os drops.
5. **Testar no Android real em DeX**: mic, DualShock, MIDI, stems, letras e vozes; medir tempo dos stems.

## Notas

- PWA (manifest + service worker) para instalar e guardar os modelos em cache.
- Testar o desempenho do áudio no telemóvel (latência, cortes) antes de juntar a IA.
