# Phase 1: Foundation — Tauri + PTY — Pattern Map

**Mapped:** 2026-08-05
**Files analyzed:** 3 (arquivos existentes com gaps identificados)
**Analogs found:** 3/3 — todos os arquivos já existem no codebase; a tarefa é modificar, não criar do zero

---

## Contexto

Esta fase NÃO parte do zero. O código central já existe e compila. O mapeamento abaixo aponta
para os sítios exatos de modificação dentro dos arquivos existentes, com os trechos de código
atuais que devem ser alterados e os trechos de substituição propostos pela pesquisa.

---

## File Classification

| Arquivo | Role | Data Flow | Estado | Gaps |
|---------|------|-----------|--------|------|
| `app/src-tauri/src/main.rs` | entrypoint | — | COMPLETO (FND-01 implementado) | nenhum |
| `app/src-tauri/src/lib.rs` | service / backend | streaming + event-driven | QUASE COMPLETO | D-04: sem mpsc backpressure; sem stdout_buf em PtySession |
| `app/src/components/Terminal.tsx` | component | streaming + request-response | QUASE COMPLETO | FND-05: ResizeObserver sem debounce |

---

## Pattern Assignments

### `app/src-tauri/src/main.rs` — COMPLETO, sem modificação necessária

**Estado:** FND-01 satisfeito. WEBKIT_DISABLE_DMABUF_RENDERER setado antes do builder.

**Trecho correto (linhas 4–13):**
```rust
fn main() {
    // Wayland/Hyprland fix: WebKitGTK renders a blank window under the DMABUF
    // renderer on many Wayland + NVIDIA setups. Force it off before Tauri boots.
    // Must run before the Tauri builder — env must be set before WebKit init.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    app_lib::run()
}
```

Nenhuma modificação. Preservar exatamente como está.

---

### `app/src-tauri/src/lib.rs` — GAP D-04 (dois sub-gaps)

**Role:** service, streaming + event-driven
**Analog:** o próprio arquivo — modificação cirúrgica em dois sítios

#### Sub-gap 1: stdout_buf ausente em PtySession (linha 18–22)

**Código atual (linhas 18–22):**
```rust
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}
```

**Modificação necessária — adicionar campo `stdout_buf`:**
```rust
use std::sync::Arc;

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    stdout_buf: Arc<Mutex<Vec<u8>>>,  // acumula output para retorno do MCP em Phase 4
}
```

**Impacto em cascata:** `manager.sessions.lock().unwrap().insert(...)` (linhas 117–124) deve incluir
o novo campo na construção de PtySession. Adicionar antes do insert:
```rust
let stdout_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
```
E na construção:
```rust
PtySession {
    writer,
    master,
    killer,
    stdout_buf,
}
```

#### Sub-gap 2: read loop sem fan-out nem backpressure (linhas 95–109)

**Código atual (linhas 95–109):**
```rust
let app_reader = app.clone();
std::thread::spawn(move || {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if on_data.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = app_reader.emit("pty_exit", id);
});
```

**Problema:** `on_data.send()` é chamado diretamente no read thread. Se Channel::send() bloquear
quando o buffer IPC estiver cheio, o thread para de drenar o PTY master fd, bloqueando o processo
filho (bash/claude) na escrita em stdout. Além disso, sem `stdout_buf`, o output não é acumulado.

**Modificação necessária — read loop com fan-out:**
```rust
let stdout_buf_reader = Arc::clone(&stdout_buf);
let app_reader = app.clone();
std::thread::spawn(move || {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                // Sempre acumula no buffer (para MCP return em Phase 4)
                if let Ok(mut acc) = stdout_buf_reader.lock() {
                    acc.extend_from_slice(chunk);
                }
                // Tenta enviar ao Channel; se falhar, descarta o chunk
                // (backpressure: drena o PTY mesmo se o frontend estiver lento)
                let _ = on_data.send(chunk.to_vec());
            }
        }
    }
    let _ = app_reader.emit("pty_exit", id);
});
```

**Nota sobre Channel::send():** Se `send()` for bloqueante em Tauri 2.11.x, substituir por
um canal `std::sync::mpsc::sync_channel(64)` com `try_send()`, e um segundo thread que drena
o canal e envia ao Channel. Verificar empiricamente com teste de carga antes de decidir.

#### Padrão de imports a adicionar no topo de lib.rs (após os imports existentes)

**Imports existentes (linhas 8–15):**
```rust
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
```

**Adicionar:**
```rust
use std::sync::Arc;
```

---

### `app/src/components/Terminal.tsx` — GAP FND-05 (ResizeObserver sem debounce)

**Role:** component, streaming
**Analog:** o próprio arquivo — modificação cirúrgica no bloco ResizeObserver

#### Sítio de modificação: ResizeObserver (linhas 69–76)

**Código atual (linhas 69–76):**
```typescript
const resizeObserver = new ResizeObserver(() => {
  try {
    fit.fit();
  } catch {
    /* element not measurable yet */
  }
});
resizeObserver.observe(host);
```

**Problema:** `fit.fit()` é chamado em toda observação de resize sem debounce. Durante animações
ou redimensionamentos rápidos de janela, dezenas de chamadas se acumulam. Cada `fit.fit()` que
altera cols/rows dispara `term.onResize` (linha 61–63), que chama `invoke("pty_resize", ...)` —
gerando dezenas de chamadas IPC desnecessárias ao backend.

**Modificação necessária — debounce de 16ms (~1 frame):**
```typescript
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const resizeObserver = new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    try {
      fit.fit();
    } catch {
      /* element not measurable yet */
    }
  }, 16);
});
resizeObserver.observe(host);
```

**Nota:** `term.onResize` (linha 61) já tem guard implícito — xterm só dispara quando cols/rows
efetivamente mudam. O debounce é uma proteção adicional contra ResizeObserver chamando fit()
múltiplas vezes durante um único evento de resize animado.

#### Cleanup: resizeTimer deve ser limpo no return do useEffect (linha 82–88)

**Código atual do cleanup (linhas 82–88):**
```typescript
return () => {
  disposed = true;
  resizeObserver.disconnect();
  void unlisten.then((f) => f());
  if (ptyId !== null) void invoke("pty_kill", { id: ptyId });
  term.dispose();
};
```

**Modificação — adicionar limpeza do timer:**
```typescript
return () => {
  disposed = true;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeObserver.disconnect();
  void unlisten.then((f) => f());
  if (ptyId !== null) void invoke("pty_kill", { id: ptyId });
  term.dispose();
};
```

---

## Padrões Estabelecidos (não modificar — referência para fases seguintes)

### Channel-per-PTY para output streaming

**Fonte:** `app/src-tauri/src/lib.rs` linhas 50–58 e `app/src/components/Terminal.tsx` linhas 44–45

O pattern correto já está implementado. Fases 3 e 4 devem copiar exatamente:

```rust
// Rust: parâmetro Channel na assinatura do comando
on_data: Channel<Vec<u8>>,
```

```typescript
// TypeScript: Channel tipado, onmessage escreve Uint8Array no xterm
const onData = new Channel<number[]>();
onData.onmessage = (bytes) => term.write(new Uint8Array(bytes));
ptyId = await invoke<number>("pty_spawn", { cols: term.cols, rows: term.rows, onData });
```

### Orphan cleanup via PtyManager::kill_all

**Fonte:** `app/src-tauri/src/lib.rs` linhas 30–45 e 177–180

Padrão correto para FND-06. Fases seguintes não devem alterar:

```rust
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

Hook em CloseRequested (linhas 177–180):
```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { .. } = event {
        window.state::<PtyManager>().kill_all();
    }
})
```

### xterm.js setup com CanvasAddon + FitAddon

**Fonte:** `app/src/components/Terminal.tsx` linhas 1–7 e 23–38

Padrão correto para Phase 1. Phase 3 substitui CanvasAddon pelo WebGL no nó focado:

```typescript
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

const term = new XTerm({
  fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: "#161514", foreground: "#e6e1dc", cursor: "#c9433a" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(host);
term.loadAddon(new CanvasAddon());
fit.fit();
```

---

## Shared Patterns

### Backpressure no read thread (D-04)

**Aplicar a:** qualquer futuro comando `pty_spawn` variante (Phase 4 MCP handler `spawn_agent`)
**Princípio:** o read thread NUNCA bloqueia esperando o frontend; sempre drena o fd do PTY master

### Cleanup no return de useEffect

**Aplicar a:** todos os componentes React com xterm, ResizeObserver, ou listeners Tauri
**Fonte:** `Terminal.tsx` linhas 82–88 — padrão correto de cleanup de recursos imperativos em React

### Arc<Mutex<T>> para estado compartilhado entre threads

**Aplicar a:** qualquer dado que o read thread e o thread principal precisem acessar (stdout_buf)
**Fonte:** padrão estabelecido pela extensão de PtySession em lib.rs

---

## No Analog Found

Nenhum arquivo desta fase está sem analog — todos os três arquivos existem no codebase.
A pesquisa não identificou nenhum gap que exija uma implementação completamente nova.

---

## Metadata

**Escopo de busca:** `app/src-tauri/src/` e `app/src/components/`
**Arquivos lidos:** 5 (main.rs, lib.rs, Terminal.tsx, CONTEXT.md, RESEARCH.md)
**Data do mapeamento:** 2026-08-05
