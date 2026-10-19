# Architettura

## Il problema

Con più agenti Claude Code in parallelo, su dispositivi diversi, il costo più alto è l'attenzione: un agente resta fermo per ore in attesa di una risposta e nessuno se ne accorge. EvoFlow risponde a una domanda sola: **chi ha bisogno di me adesso, e perché?**

## Flusso dei dati

```
 Sessione cloud (iPhone/iPad/web)          Sessione locale (desktop/CLI)
   hook Claude Code ──┐                        hook Claude Code ──┐
                      │ POST /api/events (Bearer INGEST_TOKEN)    │
                      ▼                                           ▼
              ┌──────────────────────── Cloudflare Worker ─────────────────────┐
              │  ingest.ts: evento → riga `sessions` (campi brevi, niente      │
              │  comandi né contenuti)                 D1 (SQLite)             │
              │  state.ts: riga + ora → stato, motivo, da quando               │
              └────────────────────────────────────────────────────────────────┘
                      ▲ POST /api/snapshots                  │ GET /api/sessions (ogni 5 s)
                      │ (ogni 4 h)                           ▼
     Attività programmata Claude:                   Dashboard PWA (public/)
     elenco ufficiale delle sessioni                iPhone · iPad · desktop
```

- **Hook** (`public/hooks/evoflow-hook.sh`). Riceve l'evento da Claude Code su stdin, aggiunge repo, branch, host e ID della sessione cloud, poi lo invia in background. Non blocca e non fa mai fallire la sessione.
- **Snapshot** (`/api/snapshots`). È l'elenco ufficiale delle sessioni, letto da Claude con il connettore Claude Code Remote. Contiene campi che gli hook non hanno, come `needs_action`, costo e contesto usato. Lo stato dello snapshot vale solo se è più recente dell'ultimo evento hook.
- **Nessuna API interna**: la dashboard non legge mai le API non documentate di claude.ai e non usa i token presenti nei container.

## Stati

Sono calcolati in `src/core/state.ts`, l'unico punto che decide. Sono elencati in ordine di priorità.

| Stato | Da hook | Da snapshot |
|---|---|---|
| **Ti aspetta** | `Notification` (permesso o input); oppure `Stop` con una risposta che finisce con una domanda | `needs_action` non vuoto o bucket `blocked` |
| **Fallita** | — | bucket `failed` |
| **Dimenticata** | *Ti aspetta* o *Da rivedere* da più di 48 h (`FORGOTTEN_HOURS`) | idem |
| **Da rivedere** | `Stop` senza domanda (turno finito) | bucket `review_ready` |
| **Al lavoro** | `UserPromptSubmit`, `Pre/PostToolUse`, `SubagentStop`. Viene segnalata come *silenziosa* dopo 15 min senza eventi | bucket `working` |
| **Chiusa** | `SessionEnd`, oppure archiviata da te (finché la sessione non fa qualcosa di nuovo) | bucket `completed` |

Regole di dettaglio:
- La notifica "Claude is waiting for your input", che Claude Code manda dopo un turno finito, viene ignorata perché lo `Stop` dice già la stessa cosa.
- Un `SubagentStop` che arriva a turno già finito non riporta la sessione ad *Al lavoro*.

## Cosa è stato verificato e come

| Fatto | Verifica |
|---|---|
| Campi reali degli eventi hook, compreso `last_assistant_message` in `Stop` | sessione Claude Code reale con hook che salvano gli eventi su file. Payload in `tests/fixtures/hook-probe.jsonl` |
| Gli hook in `.claude/settings.json` di progetto partono e consegnano gli eventi | `install.sh --project` in un repo di prova + sessione Claude reale → evento ricevuto dal server locale |
| Nelle sessioni cloud c'è `CLAUDE_CODE_REMOTE_SESSION_ID=cse_X`, e il link è `claude.ai/code/session_X` | variabile letta in una sessione cloud; il formato del link coincide con quello usato da Claude stesso |
| L'elenco ufficiale delle sessioni ha `status_bucket` e `post_turn_summary.needs_action` | lettura reale con il connettore Claude Code Remote |
| Non esiste un'API pubblica per elencare le sessioni | [anthropics/claude-code#35607](https://github.com/anthropics/claude-code/issues/35607), chiusa "not planned" |

**Non verificato:**
- che lo *script di setup* dell'ambiente cloud riesca a installare gli hook per tutte le sessioni (il piano B per singolo repo invece è verificato);
- il formato esatto di `Notification`, cioè `message` e `notification_type`: il codice gestisce entrambi i casi;
- le voci di menu esatte di Cloudflare.

## API

| Metodo e percorso | Autenticazione | |
|---|---|---|
| `POST /api/events` | Bearer `INGEST_TOKEN` | `{v:1, meta:{…}, payload:<input dell'hook>}` → 204 |
| `POST /api/snapshots` | Bearer `INGEST_TOKEN` | `{sessions:[…elenco sessioni…]}` → `{upserted}` |
| `POST /api/login` / `logout` | — | cookie HttpOnly firmato con HMAC della password |
| `GET /api/sessions` | cookie o Bearer `DASHBOARD_PASSWORD` (il token degli hook è di sola scrittura) | `SessionsResponse` (`src/core/types.ts`) |
| `POST /api/sessions/:key/dismiss` / `restore` | cookie o Bearer | archivia o ripristina |
| `GET` / `POST /api/diary` | cookie o Bearer | diario "mi sono perso", salvato con i contatori del momento |

## Scelte

- **Zero dipendenze npm.** Il Worker è TypeScript che Cloudflare compila al deploy, il frontend è JavaScript puro, i test usano `node --test`. In locale `tools/dev.ts` fa girare il Worker con SQLite di Node al posto di D1. Ci sono meno cose da aggiornare e da rompere.
- **Lo schema del database** viene creato automaticamente alla prima richiesta, quindi non serve un passo di migrazione.
- **Polling ogni 5 s** a pagina visibile, fermo quando è nascosta. Non usiamo WebSocket perché sul piano gratuito di Cloudflare servirebbero i Durable Objects.

## Sviluppo

```sh
npm run dev                                                    # http://localhost:8787, password "dev"
node tools/replay.ts tests/fixtures/scenario-demo.json --fast  # dati demo per ogni stato
npm test                                                       # stato, ingestione, API, script shell
npm run typecheck                                              # richiede tsc
```
