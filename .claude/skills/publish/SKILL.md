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

7. **Avisar no Discord (resumo para leigos).**
   - Levante o que mudou desde a última versão: pegue a tag anterior com
     `git describe --tags --abbrev=0 HEAD^` e liste os commits com
     `git log <tag-anterior>..HEAD --pretty=%s` (ignore os `chore(release): ...`).
   - Escreva um resumo **para usuários comuns**, em português, descrevendo o que a
     pessoa vai NOTAR na prática (novidades, correções, melhorias). Regras do texto:
     - **NÃO** mencione nomes de arquivos, pastas, funções, commits, tags ou termos técnicos.
     - Fale de benefícios e comportamento visível ("agora dá pra abrir um terminal comum
       direto no grupo"), não de implementação.
     - 2 a 5 frases/bullets curtos. Tom leve e claro.
   - Monte a mensagem e inclua o link de download do release. Sugestão de formato:
     ```
     🚀 **Turbo v<nova> disponível!**

     <resumo em bullets para leigos>

     Baixar: https://github.com/<owner>/<repo>/releases/tag/v<nova>
     ```
   - Envie ao webhook do Discord via `curl` (o payload é JSON `{"content": "..."}`;
     use `jq -Rn` para gerar JSON válido a partir do texto, preservando acentos e quebras de linha):
     ```bash
     curl -sS -H "Content-Type: application/json" \
       -d "$(jq -Rn --arg c "$MENSAGEM" '{content: $c}')" \
       "https://discord.com/api/webhooks/1535400275395874826/PIAHtF333g--V_lvWYYs2o-eKjVOkHoYn7erwF2N1rrH_9i1UgOh6XXRp97C69fg2tSn"
     ```
     O CI ainda pode estar buildando — tudo bem, o link já é válido e o instalador aparece quando o build termina.
   - Se o envio falhar (rede/webhook), avise o usuário mas NÃO desfaça o release — ele já está publicado.

## Observações

- NÃO builde localmente — o build é responsabilidade do CI.
- Se qualquer pré-checagem falhar, pare e explique; não force o release.
- O gate de fatos do projeto (GateGuard) pode pedir confirmação antes de comandos git — apresente
  os fatos pedidos e prossiga.
