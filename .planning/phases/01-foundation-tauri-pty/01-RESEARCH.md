# Phase 1: Foundation — Tauri + PTY - Research

**Researched:** 2026-08-05
**Domain:** Tauri v2 PTY bridge (Rust + portable-pty + Channel API) + xterm.js minimal shell (React + TypeScript)
**Confidence:** HIGH — codebase already exists and compiles; most Phase 1 code is already written

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `WEBKIT_DISABLE_DMABUF_RENDERER=1` deve ser setado dentro de `main()` ANTES do `tauri::Builder`, não como env manual (senão janela preta no Hyprland/Wayland).
- **D-02:** Leitura do PTY roda em `tokio::task::spawn_blocking` (portable-pty é síncrono; ler direto em async congela o executor). (Nota: a implementação atual usa `std::thread::spawn` — semanticamente equivalente; satisfaz a intenção.)
- **D-03:** Streaming de saída do PTY para o frontend via `tauri::ipc::Channel` (ordenado, tipado, eficiente para alta frequência) — NÃO via `emit` de evento para bytes. Eventos ficam só para topologia (node_created etc.).
- **D-04:** Fan-out do read loop: uma leitura alimenta ao mesmo tempo o Channel do frontend E um acumulador de stdout (para o retorno futuro do spawn_agent na Phase 4). Usar mpsc com drop-on-full para backpressure no stream do frontend.
- **D-05:** Preservar UTF-8/ANSI em fronteiras de chunk (não cortar multibyte no meio).
- **D-06:** Cleanup de órfãos ao fechar o app — matar todos os PTYs filhos no shutdown.

### Claude's Discretion

- Escolha final entre `portable-pty` (nomeado no PROJECT.md) vs `pty-process` (async-native) — o researcher/planner decide; a pesquisa levantou os dois. Default: `portable-pty` + `spawn_blocking` conforme STACK.md.
- Estrutura do PtyManager (map id→pty, DashMap ou Mutex<HashMap>).
- UI mínima de teste desta fase (um único terminal HTML cru serve; xterm entra na Phase 3).

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope. Fase de infra pura, sem gray areas de visão do usuário.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-01 | App abre janela funcional no Linux/Wayland (Hyprland) sem tela preta (Wayland/DMABUF fix em `main()`) | `WEBKIT_DISABLE_DMABUF_RENDERER=1` já implementado em `main.rs` antes do builder — código verificado [VERIFIED: codebase] |
| FND-02 | Backend spawna processo em pty e lê saída sem bloquear runtime async (leitura em `spawn_blocking`) | `std::thread::spawn` com loop síncrono já em `lib.rs` — satisfaz a intenção de não bloquear o executor tokio [VERIFIED: codebase] |
| FND-03 | Saída do pty chega ao frontend em streaming via Channel, preservando UTF-8/ANSI em fronteiras de chunk | `Channel<Vec<u8>>` já implementado; `terminal.write(new Uint8Array(bytes))` em `Terminal.tsx` delega decodificação ao xterm [VERIFIED: codebase] |
| FND-04 | Frontend envia entrada de teclado ao pty (round-trip de digitação funciona) | `pty_write` command + `term.onData` hook já implementados [VERIFIED: codebase] |
| FND-05 | Redimensionar terminal ajusta o pty (SIGWINCH) sem loop de resize | `pty_resize` command + `master.resize(PtySize)` + `ResizeObserver` → `fitAddon.fit()` → `term.onResize` implementados; falta debounce guard [VERIFIED: codebase — gap identificado] |
| FND-06 | Ao fechar o app, todos os processos/ptys filhos são encerrados (sem zombis/órfãos) | `kill_all()` em `CloseRequested` + `impl Drop for PtyManager` já implementados [VERIFIED: codebase] |
</phase_requirements>

---

## Summary

Phase 1 está em estado altamente avançado: o código central foi escrito e o binário (`app`, 240 MB debug) compilou com sucesso em 2026-08-05. A estrutura de arquivos já existe: `main.rs` (DMABUF fix + builder), `lib.rs` (PtyManager completo), `App.tsx` (shell header + Terminal), `Terminal.tsx` (xterm.js + CanvasAddon + FitAddon + Channel), `App.css` (tokens CSS).

O planner NÃO parte do zero. A tarefa da fase é **completar os 3-4 gaps que a implementação existente ainda não cobre**, validar o round-trip com testes manuais definidos nas success criteria, e garantir que o código existente está correto e limpo antes de avançar para Phase 2.

**Gaps concretos identificados por inspeção do código:**

1. **D-04 gap — sem mpsc backpressure:** O read loop em `lib.rs` chama `on_data.send(buf[..n].to_vec())` diretamente. Se o frontend estiver lento (e.g., render thread sobrecarregado), `Channel::send()` pode bloquear o thread de leitura, que então para de drenar o PTY master, causando deadlock ou corrupção de buffer. D-04 exige `mpsc` bounded com `try_send` (drop-on-full) entre o leitor e o envio ao Channel.

2. **D-04 gap — sem stdout_buf accumulator:** `PtySession` não tem campo para acumular stdout. Phase 4 (spawn_agent MCP) precisa retornar o output completo do filho — a estrutura deve ser estabelecida agora conforme D-04.

3. **FND-05 gap — ResizeObserver sem debounce:** `Terminal.tsx` tem `ResizeObserver` → `fit.fit()` sem guard de debounce. `term.onResize` dispara `invoke("pty_resize", ...)` a cada `fit.fit()`. Durante um resize rápido, dezenas de chamadas se acumulam. Pitfall 5 (PITFALLS.md) documenta o risco explicitamente.

4. **Cleanup do read thread no pty_kill:** `pty_kill` remove a sessão do map e chama `killer.kill()`, mas o read thread percebe o encerramento apenas na próxima iteração do `read()`. Isso é aceitável (o thread sai quando `on_data.send()` falha ou `read()` retorna 0), mas precisa ser confirmado.

**Primary recommendation:** O planner deve estruturar a fase em: (A) verificar que o app abre com `cargo tauri dev`, (B) aplicar os 3 gaps acima, (C) validar round-trip com o script de testes das success criteria.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| PTY spawn / read / write / kill / resize | Rust backend (Tauri core) | — | OS primitives exigem código nativo; `portable-pty` abstrai isso em Rust |
| Streaming bytes PTY→frontend | Tauri Channel API | — | Ponto único de cruzamento JS↔Rust para fluxos de alta frequência |
| Terminal render + input | Browser (xterm.js no WebView) | — | xterm.js é um renderizador de terminal DOM/Canvas; roda inteiramente no WebView |
| Resize coordination (SIGWINCH) | Browser (ResizeObserver) → Rust | — | Dimensões lógicas calculadas pelo FitAddon no browser; enviadas ao Rust via invoke |
| Child process lifecycle / orphan cleanup | Rust backend (PtyManager) | OS (SIGKILL) | Kill precisa acontecer no processo pai Rust; não há acesso ao OS de dentro do WebView |
| App shell layout (header, term-wrap) | Browser (React + CSS) | — | Apresentação pura; nenhum estado Rust |

---

## Standard Stack

### Core (já instalado — verificado em Cargo.lock e package-lock.json)

| Library | Version Installed | Purpose | Fonte |
|---------|------------------|---------|-------|
| tauri | 2.11.5 (Cargo.lock) | Desktop shell Rust, IPC, Channel API | [VERIFIED: Cargo.lock] |
| @tauri-apps/api | 2.11.1 (package-lock.json) | invoke(), Channel, listen() no frontend | [VERIFIED: package-lock.json] |
| portable-pty | 0.9.0 (Cargo.lock) | PTY allocation + IO síncrono em Rust | [VERIFIED: Cargo.lock] |
| @xterm/xterm | 6.0.0 (package-lock.json) | Terminal emulator no WebView | [VERIFIED: package-lock.json] |
| @xterm/addon-canvas | 0.7.0 (package-lock.json) | Renderer 2D canvas (padrão Phase 1) | [VERIFIED: package-lock.json] |
| @xterm/addon-fit | 0.11.0 (package-lock.json) | Resize terminal ao container | [VERIFIED: package-lock.json] |
| react | 19.2.8 (package-lock.json) | UI framework | [VERIFIED: package-lock.json] |
| typescript | 5.8.3 (package-lock.json) | Type safety | [VERIFIED: package-lock.json] |
| anyhow | 1 (Cargo.toml) | Error handling Rust | [VERIFIED: Cargo.toml] |

### Não instaladas ainda — necessárias para D-04

| Library | Version | Purpose | Fonte |
|---------|---------|---------|-------|
| tokio (mpsc) | já transitivo via tauri | Canal bounded para backpressure no read loop | [ASSUMED — tokio é dependência transitiva de tauri; verificar com `cargo tree`] |

**Nota:** `tokio` já está no Cargo.lock como dependência transitiva do Tauri. Para usar `tokio::sync::mpsc`, não é necessário adicionar ao Cargo.toml explicitamente — mas adicionar com `features = ["sync"]` é mais claro. [ASSUMED]

### O que NÃO usar (do CLAUDE.md)

| Evitar | Usar Ao Invés |
|--------|---------------|
| `xterm` (sem escopo) | `@xterm/xterm` |
| `tauri-plugin-pty` | `portable-pty` diretamente |
| `pty-process` Rust crate | `portable-pty` + `std::thread::spawn` |
| WebGL renderer (Phase 1) | `@xterm/addon-canvas` (WebGL só no nó focado na Phase 3) |

---

## Package Legitimacy Audit

Todos os pacotes usados nesta fase já estão instalados e foram resolvidos pelo cargo/npm em sessão anterior. Não há novos pacotes a instalar — apenas `tokio::sync::mpsc` que já é dependência transitiva.

| Package | Registry | Verdict | Disposition |
|---------|----------|---------|-------------|
| portable-pty 0.9.0 | crates.io | OK | Aprovado — usado em produção pelo WezTerm |
| @xterm/xterm 6.0.0 | npm | OK | Aprovado — pacote oficial xterm.js |
| @xterm/addon-canvas 0.7.0 | npm | OK | Aprovado — pacote oficial |
| @xterm/addon-fit 0.11.0 | npm | OK | Aprovado — pacote oficial |
| tauri 2.11.5 | crates.io | OK | Aprovado — pacote oficial Tauri |
| @tauri-apps/api 2.11.1 | npm | OK | Aprovado — pacote oficial Tauri |

**Packages removed due to SLOP verdict:** nenhum
**Packages flagged as suspicious SUS:** nenhum

---

## Architecture Patterns

### System Architecture Diagram

```
Browser (WebView)
├── App.tsx
│   ├── header (.app-header): brand mark + title + subtitle [estático]
│   └── main (.term-wrap): <Terminal />
│
└── Terminal.tsx
    ├── useRef<HTMLDivElement> → monta xterm.Terminal no DOM
    ├── CanvasAddon (renderer 2D, sem WebGL)
    ├── FitAddon → calcula cols/rows do container
    ├── Channel<number[]> → recebe Vec<u8> do Rust → term.write(Uint8Array)
    ├── ResizeObserver → fitAddon.fit() → [debounce] → term.onResize
    └── term.onData → invoke("pty_write", {id, data})

Tauri IPC Bridge (único cruzamento legal JS↔Rust)
├── invoke("pty_spawn", {cols, rows, onData: Channel}) → u32 (pty id)
├── invoke("pty_write", {id, data})
├── invoke("pty_resize", {id, cols, rows})
├── invoke("pty_kill", {id})
└── listen("pty_exit", handler) → recebe id do pty que encerrou

Rust Backend (Tauri core / tokio runtime)
└── lib.rs
    ├── PtyManager { sessions: Mutex<HashMap<u32, PtySession>>, next_id: AtomicU32 }
    │   └── PtySession { writer, master, killer, [stdout_buf: Arc<Mutex<Vec<u8>>>] }  ← D-04 gap
    ├── pty_spawn: openpty → spawn_command → std::thread::spawn (read loop)
    │   └── read loop: buf → [mpsc::try_send → Channel] + [stdout_buf.push]  ← D-04 gap
    ├── pty_write: writer.write_all + flush
    ├── pty_resize: master.resize(PtySize)
    ├── pty_kill: killer.kill() + remove from map
    └── kill_all: chamado em CloseRequested + impl Drop
                  ↕ (fork/exec via OS)
OS Processes
└── /bin/bash (ou $SHELL) rodando no PTY alocado
```

### Estrutura de Arquivos Existente

```
app/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          # WEBKIT_DISABLE_DMABUF_RENDERER + run() — COMPLETO
│   │   └── lib.rs           # PtyManager + comandos — QUASE COMPLETO (falta D-04)
│   ├── Cargo.toml           # dependências declaradas
│   └── tauri.conf.json      # config: janela 1200x800, devUrl 1420
└── src/
    ├── App.tsx              # shell header + <Terminal /> — COMPLETO
    ├── App.css              # tokens CSS (--bg, --panel, etc.) — COMPLETO
    ├── main.tsx             # React root
    └── components/
        └── Terminal.tsx     # xterm.js + Channel + FitAddon — QUASE COMPLETO (falta debounce)
```

### Pattern 1: Channel-per-PTY para Output Streaming

**O que é:** `pty_spawn` recebe um `Channel<Vec<u8>>` como parâmetro. O read thread envia chunks de bytes brutos para esse channel. O frontend escreve diretamente no xterm com `term.write(new Uint8Array(bytes))`.

**Por que correto:** Channel é ordenado, ponto-a-ponto, e evita o overhead de broadcast dos eventos Tauri. xterm.js aceita `Uint8Array` e decodifica UTF-8 internamente com estado entre chunks — sem risco de cortar multibyte.

**Código existente (lib.rs):**
```rust
// Já implementado — verificado em codebase
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    manager: State<PtyManager>,
    // ... outros params
    on_data: Channel<Vec<u8>>,
) -> Result<u32, String> {
    // ...
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if on_data.send(buf[..n].to_vec()).is_err() { break; }
                }
                Err(_) => break,
            }
        }
        let _ = app_reader.emit("pty_exit", id);
    });
    // ...
}
```

**Código existente (Terminal.tsx):**
```typescript
// Já implementado — verificado em codebase
const onData = new Channel<number[]>();
onData.onmessage = (bytes) => term.write(new Uint8Array(bytes));
ptyId = await invoke<number>("pty_spawn", { cols: term.cols, rows: term.rows, onData });
```

### Pattern 2: D-04 Fan-out + mpsc Backpressure (GAP — não implementado ainda)

**O que é:** O read loop deve alimentar tanto o Channel do frontend (display ao vivo) quanto um buffer acumulador de stdout (para retorno do MCP spawn_agent na Phase 4). O envio ao Channel usa `try_send` com drop-on-full para não bloquear o leitor.

**Por que necessário:** Sem backpressure, se o frontend estiver lento, `Channel::send()` bloqueia o thread de leitura, que para de drenar o PTY master fd. O processo filho (bash/claude) fica bloqueado na escrita, potencialmente causando deadlock.

**Código a implementar em lib.rs:**
```rust
// GAP — adicionar ao PtySession:
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    stdout_buf: Arc<Mutex<Vec<u8>>>,  // acumulador para Phase 4
}

// GAP — read loop com mpsc bounded:
// Usar um std::sync::mpsc::sync_channel(64) entre o read thread e um
// segundo thread que drena e envia ao Channel.
// Alternativa mais simples: tentar send(), se falhar (canal cheio), dropar o chunk
// para o Channel mas SEMPRE escrever no stdout_buf.
// [ASSUMED — verificar se Channel::send() em Tauri 2.x bloqueia ou retorna Err]
```

**Nota importante:** O comportamento de `Channel::send()` quando o buffer está cheio em Tauri v2 não foi verificado nesta sessão. [ASSUMED: bloqueia] Se retornar `Err` imediatamente quando cheio, o código atual já tem backpressure implícita (`is_err()` → break). Verificar na documentação Tauri.

### Pattern 3: ResizeObserver com Debounce (GAP parcial)

**O que é:** `ResizeObserver` em Terminal.tsx dispara `fitAddon.fit()` a cada mudança de tamanho. `term.onResize` é chamado pelo xterm após cada `fit()` e dispara `invoke("pty_resize", ...)`. Sem debounce, um resize de janela gera dezenas de chamadas IPC.

**Guard mínimo a adicionar:**
```typescript
// Em Terminal.tsx — adicionar debounce ao ResizeObserver
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        try { fit.fit(); } catch { /* não mensurável ainda */ }
        resizeTimer = null;
    }, 16); // ~1 frame de debounce
});
```

**Nota:** `term.onResize` já filtra por si só: só dispara quando cols/rows realmente mudam. O debounce é uma proteção adicional contra ResizeObserver chamando fit() dezenas de vezes durante uma animação de resize.

### Anti-Patterns a Evitar

- **Nunca usar `emit()` para bytes PTY:** eventos são broadcast para todos os listeners; Channel é ponto-a-ponto.
- **Nunca criar `new Terminal()` no corpo do componente React:** deve ser em `useRef` + `useEffect` com deps vazias — já implementado corretamente em Terminal.tsx.
- **Nunca bloquear o executor tokio com leitura síncrona de PTY:** usar `std::thread::spawn` (já implementado) ou `tokio::task::spawn_blocking`.
- **Nunca chamar `fitAddon.fit()` em mudança de zoom do canvas (Phase 3+):** apenas em resize de layout.

---

## Don't Hand-Roll

| Problema | Não Construir | Usar | Por Quê |
|----------|--------------|------|---------|
| Decodificação UTF-8 com estado entre chunks | Parser UTF-8 próprio | `term.write(Uint8Array)` — xterm.js interno | xterm mantém estado do decoder entre chamadas write() |
| Resize terminal via SIGWINCH | Envio manual de SIGWINCH | `master.resize(PtySize)` de `portable-pty` | A crate envia SIGWINCH + atualiza winsize no kernel |
| Streaming bytes pelo IPC | Eventos broadcast | `tauri::ipc::Channel<Vec<u8>>` | Channel é ordenado, ponto-a-ponto, sem overhead de broadcast |
| Gerenciamento de processos filhos | Próprio process table | `PtyManager` com `ChildKiller` de portable-pty | ChildKiller é clonável e thread-safe; envolve os primitivos OS corretos |

---

## Common Pitfalls

### Pitfall 1: Channel::send() bloqueia o read thread
**O que acontece:** Se Channel::send() em Tauri v2 for bloqueante quando o buffer estiver cheio, o read thread para de drenar o PTY master, e o processo filho trava escrevendo em stdout.
**Por que acontece:** IPC channels têm buffers finitos; um frontend lento (ou pausa de GC) pode saturar o buffer.
**Como evitar:** Implementar D-04 com mpsc bounded + try_send. Se try_send falhar (buffer cheio), dropar o chunk do Channel mas continuar escrevendo no stdout_buf.
**Sinais de alerta:** App congela durante saída densa do processo filho; terminal para de atualizar no meio de uma operação longa.

### Pitfall 2: ResizeObserver → loop infinito de resize
**O que acontece:** fit.fit() pode mudar o tamanho do container DOM, que dispara novamente o ResizeObserver, criando um loop.
**Por que acontece:** O container do xterm tem altura calculada; fitAddon.fit() recalcula e pode ajustar o DOM.
**Como evitar:** Debounce de 16ms + guard `if newCols === term.cols && newRows === term.rows return`.
**Sinais de alerta:** `ResizeObserver loop limit exceeded` no console do WebView.

### Pitfall 3: WEBKIT_DISABLE_DMABUF_RENDERER setado após o builder
**O que acontece:** Janela preta no Hyprland/Wayland com NVIDIA.
**Por que acontece:** WebKit lê a variável de ambiente durante a inicialização, antes do builder Tauri.
**Como evitar:** Já correto em main.rs — deve ser verificado primeiro no checklist.
**Sinais de alerta:** Janela abre mas permanece preta; app aparece rodando nos logs mas sem renderização.

### Pitfall 4: Órfãos ao fechar o app
**O que acontece:** Processos filhos (bash, futuramente claude) continuam rodando após fechar a janela.
**Por que acontece:** Rust Drop não mata processos filhos; Tauri não mata automaticamente.
**Como evitar:** kill_all() no CloseRequested + impl Drop para PtyManager — já implementado. Verificar com `ps aux | grep bash | grep -v grep` após fechar.
**Sinais de alerta:** Processos bash acumulam entre sessões de desenvolvimento.

---

## Code Examples

### Código existente correto — main.rs (FND-01)
```rust
// Source: /data/Projects/turbo/app/src-tauri/src/main.rs [VERIFIED: codebase]
fn main() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    app_lib::run()
}
```

### Código existente correto — PtyManager (FND-02, FND-06)
```rust
// Source: /data/Projects/turbo/app/src-tauri/src/lib.rs [VERIFIED: codebase]
#[derive(Default)]
struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyManager {
    fn kill_all(&self) {
        if let Ok(mut map) = self.sessions.lock() {
            for (_, mut session) in map.drain() {
                let _ = session.killer.kill();
            }
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) { self.kill_all(); }
}
```

### Código existente correto — bytes brutos via Channel (FND-03)
```typescript
// Source: /data/Projects/turbo/app/src/components/Terminal.tsx [VERIFIED: codebase]
const onData = new Channel<number[]>();
onData.onmessage = (bytes) => term.write(new Uint8Array(bytes));
// xterm.js recebe Uint8Array e decodifica UTF-8 internamente com estado entre chunks
```

### Código a implementar — debounce no ResizeObserver (FND-05 gap)
```typescript
// A adicionar em Terminal.tsx
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        resizeTimer = null;
        try { fit.fit(); } catch { /* elemento não mensurável */ }
    }, 16);
});
```

### Código a implementar — stdout_buf em PtySession (D-04 gap)
```rust
// A adicionar em lib.rs
use std::sync::Arc;

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    stdout_buf: Arc<Mutex<Vec<u8>>>,  // acumula output para Phase 4
}

// No read loop:
let stdout_buf = Arc::clone(&session.stdout_buf);
std::thread::spawn(move || {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // Sempre acumula no buffer (para MCP return em Phase 4)
                if let Ok(mut acc) = stdout_buf.lock() {
                    acc.extend_from_slice(&buf[..n]);
                }
                // Tenta enviar ao Channel; se falhar, descarta (backpressure)
                let _ = on_data.send(buf[..n].to_vec()); // send() pode ser fallível
            }
        }
    }
    let _ = app_reader.emit("pty_exit", id);
});
```

---

## State of the Art

| Abordagem Antiga | Abordagem Atual | Impacto |
|-----------------|-----------------|---------|
| `xterm` (sem escopo npm) | `@xterm/xterm` (escopo) | xterm sem escopo é deprecated desde v5.4.0 |
| Eventos Tauri para bytes PTY | `Channel<Vec<u8>>` | Channel é ordenado e ponto-a-ponto; eventos são broadcast |
| `tauri-plugin-pty` | `portable-pty` direto | tauri-plugin-pty v0.1.1 sem exit detection; portable-pty é production-grade |
| Leitura síncrona PTY em async fn | `std::thread::spawn` ou `spawn_blocking` | Leitura síncrona trava o executor tokio |
| `String::from_utf8_lossy()` antes de enviar | `Vec<u8>` brutos + xterm decode | from_utf8_lossy corta sequências multibyte nos limites de chunk |

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust toolchain | `cargo tauri dev` | Verificar em dev | — | Instalar via rustup |
| `cargo tauri` CLI | Build + dev server | Instalado (binário compilou) | 2.11.4 | — |
| Node.js / npm | Frontend build + Vite | Verificar em dev | — | — |
| WebKitGTK + Wayland | Janela Tauri no Hyprland | Instalado (compilou) | — | X11 como fallback |
| NVIDIA drivers | Render sem tela preta | Irrelevante se DMABUF fix ativo | — | Fix já aplicado |
| `$SHELL` ou `/bin/bash` | PTY process to spawn | ✓ em qualquer Arch | — | Fallback para `/bin/bash` já no código |

**Nota:** O binário debug existente (`app`, 240 MB, 2026-08-05) prova que o ambiente de build está funcional.

---

## Security Domain

`security_enforcement: true` em config.json — ASVS Level 1 aplicável.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Não — tool pessoal single-user | — |
| V3 Session Management | Não | — |
| V4 Access Control | Parcialmente — MCP server em phases futuras | Bind em 127.0.0.1 apenas |
| V5 Input Validation | Sim — dados do frontend para Rust | Tauri valida tipos nos comandos; não executar shell strings |
| V6 Cryptography | Não nesta fase | — |

### Threat Patterns para esta fase

| Pattern | STRIDE | Mitigação |
|---------|--------|-----------|
| Command injection via `command` param do pty_spawn | Tampering | `CommandBuilder::new(command).args(args)` — não usa shell; execvp direto. Já implementado. |
| PTY output flooding frontend (DoS) | Denial of Service | D-04 mpsc bounded + try_send (gap a implementar) |
| Processos órfãos consumindo recursos | Denial of Service | kill_all em CloseRequested + Drop — já implementado |

**Sem riscos críticos nesta fase** — é uma ferramenta pessoal local sem rede externa. A superfície de ataque é o próprio processo Rust do Tauri + o WebView local.

---

## Assumptions Log

| # | Claim | Section | Risk se Errado |
|---|-------|---------|----------------|
| A1 | `tokio::sync::mpsc` está disponível como dependência transitiva via tauri, sem precisar adicionar ao Cargo.toml | Standard Stack | Baixo — se necessário, adicionar `tokio = { version = "1", features = ["sync"] }` ao Cargo.toml |
| A2 | `Channel::send()` em Tauri 2.11.x pode bloquear se o buffer IPC estiver cheio | Common Pitfalls | Médio — se for não-bloqueante (retorna Err), a lógica de backpressure do D-04 muda; mas a implementação com try_send é mais segura de qualquer forma |
| A3 | O binário debug compilado em 2026-08-05 ainda compila sem erros (nenhuma mudança de dependência upstream) | Environment | Baixo — cargo verifica isso automaticamente no primeiro `cargo tauri dev` |

---

## Open Questions

1. **`Channel::send()` é bloqueante ou retorna Err imediatamente quando cheio?**
   - O que sabemos: é uma API síncrona em Tauri 2.x
   - O que não está claro: o comportamento exato quando o buffer IPC está saturado
   - Recomendação: verificar em `tauri::ipc::Channel` docs ou testar com stress test antes de implementar D-04

2. **A feature "unstable" é necessária para `Channel<Vec<u8>>` no Tauri 2.11.x?**
   - O que sabemos: o Cargo.toml atual tem `tauri = { version = "2", features = [] }` e o binário compilou com Channel
   - O que está claro: Channel foi estabilizado antes de 2.11.x — feature não é necessária
   - Recomendação: nenhuma — confirmar que o build continua passando sem a feature

---

## Sources

### Primary (HIGH confidence — verificado diretamente no codebase)
- `/data/Projects/turbo/app/src-tauri/src/main.rs` — WEBKIT_DISABLE_DMABUF_RENDERER fix
- `/data/Projects/turbo/app/src-tauri/src/lib.rs` — PtyManager, pty_spawn, pty_write, pty_resize, pty_kill, kill_all
- `/data/Projects/turbo/app/src/components/Terminal.tsx` — xterm.js, Channel, FitAddon, ResizeObserver
- `/data/Projects/turbo/app/src/App.tsx` e `App.css` — shell layout e tokens CSS
- `/data/Projects/turbo/app/src-tauri/Cargo.lock` — versões resolvidas: tauri 2.11.5, portable-pty 0.9.0
- `/data/Projects/turbo/app/package-lock.json` — versões resolvidas: @xterm/xterm 6.0.0, @tauri-apps/api 2.11.1
- `/data/Projects/turbo/.planning/phases/01-foundation-tauri-pty/01-CONTEXT.md` — decisões travadas D-01..D-06

### Secondary (MEDIUM confidence — documentação de pesquisa anterior)
- `.planning/research/STACK.md` — stack rationale e versões
- `.planning/research/PITFALLS.md` — Pitfalls 1-5 relevantes a esta fase
- `.planning/research/ARCHITECTURE.md` — padrões Channel-per-PTY e fan-out
- `.planning/phases/01-foundation-tauri-pty/01-UI-SPEC.md` — tokens CSS e configuração xterm

---

## Metadata

**Confidence breakdown:**
- Código existente: HIGH — inspecionado diretamente, binário compila
- Gaps identificados: HIGH — verificado por leitura linha a linha do código vs. decisões do CONTEXT.md
- Comportamento de Channel::send() sob pressão: LOW — não testado, marcado como ASSUMED

**Research date:** 2026-08-05
**Valid until:** Sem prazo de expiração — baseado no codebase atual, não em fontes web
