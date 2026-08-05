---
name: publish
description: Publica uma nova versão do Turbo. Faz bump de versão (patch/minor/major ou versão explícita) em app/package.json, app/src-tauri/tauri.conf.json e app/src-tauri/Cargo.toml, commita, cria a tag vX.Y.Z e faz push da main + tag — o que dispara o workflow de release do GitHub Actions (.github/workflows/release.yml) que builda o app Linux e publica os instaladores (.AppImage/.deb) num GitHub Release. Use quando o usuário pedir "/publish", "publica uma versão", "lança uma release", "sobe a v1.2.3" ou similar.
---

# Publish — lançar uma versão do Turbo

Automatiza o release: bump de versão sincronizado nos 3 arquivos, commit, tag e push.
O push da tag `v*` dispara `.github/workflows/release.yml`, que builda no CI (Linux) e
cria um GitHub Release com `.AppImage` e `.deb` para download.

## Arquivos de versão (mantêm-se sincronizados)

- `app/package.json` → campo `"version"`
- `app/src-tauri/tauri.conf.json` → campo `"version"`
- `app/src-tauri/Cargo.toml` → campo `version` na seção `[package]`

Os três DEVEM ficar iguais. A tag é sempre `v<versão>` (ex.: versão `0.2.0` → tag `v0.2.0`).

## Argumento

O usuário pode passar: `patch` (default), `minor`, `major`, ou uma versão explícita `X.Y.Z`.
- `patch`: 0.1.0 → 0.1.1
- `minor`: 0.1.0 → 0.2.0
- `major`: 0.1.0 → 1.0.0
- `1.4.0`: usa exatamente essa.

## Passos (siga na ordem)

1. **Pré-checagens.** Rode a partir da raiz do repo:
   - `git rev-parse --abbrev-ref HEAD` deve ser `main`. Se não, avise e pare (a menos que o usuário confirme).
   - `git status --porcelain` deve estar limpo. Se houver mudanças não commitadas, avise e pare — o release deve sair de um estado limpo.
   - Confirme o remote: `git remote get-url origin`.

2. **Ler a versão atual** de `app/package.json` (campo `version`).

3. **Calcular a nova versão** conforme o argumento (patch/minor/major/explícita).
   - Verifique que a tag ainda não existe: `git tag -l v<nova>` deve ser vazio, e
     `git ls-remote --tags origin v<nova>` também. Se existir, pare e avise.

4. **Aplicar o bump** (edições cirúrgicas, só o campo de versão):
   - `app/package.json`: `"version": "<atual>"` → `"version": "<nova>"`
   - `app/src-tauri/tauri.conf.json`: `"version": "<atual>"` → `"version": "<nova>"`
   - `app/src-tauri/Cargo.toml`: a linha `version = "<atual>"` dentro de `[package]` → `version = "<nova>"`
   - Para manter o `Cargo.lock` coerente, rode dentro de `app/src-tauri`:
     `cargo update -p app 2>/dev/null || true` (atualiza a entrada do lock; se o cargo não estiver disponível, siga — o CI regenera).

5. **Commit + tag + push:**
   ```bash
   git add app/package.json app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
   git commit -m "chore(release): v<nova>"
   git tag v<nova>
   git push origin main
   git push origin v<nova>
   ```

6. **Confirmar o disparo do CI.** Rode `gh run list --workflow release.yml --limit 3` e mostre o link.
   Informe ao usuário que quando o workflow terminar, os instaladores estarão em:
   `https://github.com/<owner>/<repo>/releases/tag/v<nova>`
   (descubra owner/repo com `gh repo view --json nameWithOwner -q .nameWithOwner`).

## Observações

- NÃO builde localmente — o build é responsabilidade do CI.
- Se qualquer pré-checagem falhar, pare e explique; não force o release.
- O gate de fatos do projeto (GateGuard) pode pedir confirmação antes de comandos git — apresente
  os fatos pedidos e prossiga.
