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

5. **Escrever o resumo para leigos** (o Discord é enviado pelo CI, NÃO aqui).
   - Levante o que mudou desde a última versão: tag anterior com
     `git describe --tags --abbrev=0 HEAD^` e commits com
     `git log <tag-anterior>..HEAD --pretty=%s` (ignore os `chore(release): ...`).
   - Escreva um resumo **para usuários comuns**, em português, do que a pessoa vai
     NOTAR na prática (novidades, correções, melhorias). Regras do texto:
     - **NÃO** mencione arquivos, pastas, funções, commits, tags ou termos técnicos.
     - Fale de benefícios / comportamento visível ("agora dá pra abrir um terminal
       comum direto no grupo"), não de implementação.
     - 2 a 5 frases/bullets curtos, tom leve e claro.
   - Grave o texto em `.github/RELEASE_MESSAGE.md` (sobrescreve o anterior), com
     título e link de download. Formato sugerido:
     ```
     🚀 **Turbo v<nova> disponível!**

     <resumo em bullets para leigos>

     Baixar: https://github.com/<owner>/<repo>/releases/tag/v<nova>
     ```
   - **NÃO** faça `curl` para o Discord daqui. O envio acontece só no CI (job
     `notify-discord` do `release.yml`), depois que os builds Linux+Windows
     terminarem com sucesso, lendo esse arquivo. A URL do webhook fica no secret
     `DISCORD_WEBHOOK` do repositório.

6. **Commit + tag + push** (inclui o arquivo da mensagem):
   ```bash
   git add app/package.json app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock .github/RELEASE_MESSAGE.md
   git commit -m "chore(release): v<nova>"
   git tag v<nova>
   git push origin main
   git push origin v<nova>
   ```

7. **Confirmar o disparo do CI.** Rode `gh run list --workflow release.yml --limit 3` e mostre o link.
   Informe ao usuário que, quando o workflow terminar, os instaladores estarão em
   `https://github.com/<owner>/<repo>/releases/tag/v<nova>`
   (owner/repo via `gh repo view --json nameWithOwner -q .nameWithOwner`) e que o
   aviso no Discord é postado **automaticamente pelo CI** ao final do build — não há
   nada a enviar manualmente.

## Observações

- NÃO builde localmente — o build é responsabilidade do CI.
- O aviso no Discord depende do secret `DISCORD_WEBHOOK` (já configurado no repo). Se
  ele faltar, o job `notify-discord` apenas pula o envio (não quebra o release).
- Se qualquer pré-checagem falhar, pare e explique; não force o release.
- O gate de fatos do projeto (GateGuard) pode pedir confirmação antes de comandos git — apresente
  os fatos pedidos e prossiga.
