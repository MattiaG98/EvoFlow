# Messa in funzione: cosa fai tu

Tempo stimato: circa 20 minuti, si può fare tutto da iPad o desktop tranne il punto 6, che richiede il computer.
I nomi delle voci di menu di Cloudflare e di Claude possono cambiare leggermente nel tempo: se non trovi una voce, cerca quella con il significato più vicino.

## 1. Account Cloudflare e database

1. Crea un account gratuito su [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Storage & Databases → D1 SQL Database → Create**, nome `evoflow`.
3. Copia il **Database ID** e mandamelo in chat (non è un segreto): lo inserisco io in `wrangler.toml`.
   In alternativa sostituisci tu `REPLACE_WITH_YOUR_D1_DATABASE_ID` in `wrangler.toml`.

## 2. Pubblicazione collegata a GitHub

1. **Workers & Pages → Create → Import a repository**, scegli `MattiaG98/EvoFlow`, branch `main`.
2. Lascia vuoto il comando di build. Il comando di deploy è `npx wrangler deploy`, che di solito è già il valore predefinito.
3. Da qui in poi ogni push su `main` ripubblica la dashboard da solo.

L'indirizzo sarà del tipo `https://evoflow.<tuo-sottodominio>.workers.dev`. Nel resto della guida lo chiamo **URL**.

## 3. Due segreti

Nel Worker `evoflow`: **Settings → Variables and Secrets → Add**, di tipo *Secret*:

| Nome | Valore |
|---|---|
| `INGEST_TOKEN` | una stringa casuale lunga (almeno 32 caratteri). Su iPhone puoi usare il generatore dell'app Password. Serve agli hook per scrivere. |
| `DASHBOARD_PASSWORD` | la password per aprire la dashboard. Anche questa lunga: l'indirizzo è pubblico. |

Facoltativo: la variabile `FORGOTTEN_HOURS` cambia la soglia "dimenticata" (predefinita: 48).

## 4. Installala su iPhone e iPad

Apri l'URL in Safari, inserisci la password, poi **Condividi → Aggiungi alla schermata Home**. Si apre a tutto schermo come un'app.

## 5. Sessioni cloud (iPhone, iPad, web)

Su claude.ai/code apri le impostazioni del tuo ambiente cloud (il menu dell'ambiente nella barra del titolo di una sessione, poi **Edit**):

1. **Network access**: aggiungi il dominio dell'URL (es. `evoflow.<tuo-sottodominio>.workers.dev`) agli *Allowed domains*, lasciando spuntato *Allow package managers*. Guida ufficiale: <https://code.claude.com/docs/en/cloud-environments#network-access>.
2. **Environment variables**:
   ```
   EVOFLOW_URL=https://evoflow.<tuo-sottodominio>.workers.dev
   EVOFLOW_TOKEN=<lo stesso INGEST_TOKEN del punto 3>
   ```
3. **Setup script**, aggiungi questa riga:
   ```sh
   curl -fsSL "$EVOFLOW_URL/hooks/install.sh" | sh
   ```
4. **Prova:** apri una nuova sessione cloud e scrivile "ciao". Entro qualche secondo deve comparire sulla dashboard.

**Se non compare:** non ho potuto verificare che lo script di setup e le variabili d'ambiente arrivino fino agli hook. In quel caso c'è un piano B già testato: installare gli hook dentro il singolo repository. Dimmi in quale repo e lo faccio io, eseguendo in una sessione su quel repo:
```sh
curl -fsSL "$EVOFLOW_URL/hooks/install.sh" | sh -s -- --project
```
Questo comando aggiunge `.claude/settings.json` e `.claude/hooks/evoflow-hook.sh` al repo. Il token non finisce mai nel repo, perché resta nelle variabili d'ambiente.

## 6. Sessioni locali (app desktop o terminale sul tuo computer)

Nel Terminale del computer:
```sh
curl -fsSL https://evoflow.<tuo-sottodominio>.workers.dev/hooks/install.sh \
  | EVOFLOW_URL=https://evoflow.<tuo-sottodominio>.workers.dev EVOFLOW_TOKEN=<INGEST_TOKEN> sh
```
- Serve `node` oppure `python3`. L'installer ti avvisa se mancano e non tocca nulla.
- Modifica `~/.claude/settings.json` aggiungendo gli hook (le altre impostazioni restano com'erano e ne salva una copia accanto). URL e token vanno in `~/.claude/evoflow/env`, leggibile solo da te.
- Vale per le **nuove** sessioni. Quelle già aperte vanno riavviate.
- Per rimuovere tutto: stesso comando con `sh -s -- --uninstall` al posto di `sh`.

## 7. Riconciliazione periodica (la faccio io)

Quando i punti 1-5 funzionano, dimmelo e creo un'attività programmata che ogni 4 ore legge l'elenco ufficiale delle tue sessioni cloud e lo invia alla dashboard. Recupera ciò che gli hook non vedono, per esempio le sessioni aperte prima dell'installazione. Ogni esecuzione consuma un po' del tuo piano Claude.

## 8. Il diario, per la verifica prima e dopo

Per una settimana, ogni volta che ti perdi (non trovi una sessione, scopri tardi che un agente ti aspettava, ti chiedi "a che punto ero?"), premi **Mi sono perso** nella dashboard. Una riga basta. Alla fine leggo il diario e vediamo se la dashboard sta facendo il suo lavoro.

## Quali dati escono dalle tue sessioni

Ogni evento viene inviato via HTTPS al **tuo** Worker. Il Worker conserva solo questi campi:
- i primi 1000 caratteri del tuo ultimo messaggio a Claude;
- i primi 4000 caratteri della sua ultima risposta;
- il testo delle richieste di permesso;
- il nome dello strumento in uso, con la sua descrizione breve o il nome del file;
- repo, branch, nome del computer.

**Non conserva** il testo dei comandi, il contenuto dei file né l'output degli strumenti. Questi viaggiano nell'evento grezzo, ma vengono scartati all'arrivo. Il registro degli eventi viene cancellato dopo 30 giorni.

## Verificare che funzioni

- **Scenario con risultato noto**: apri 3 sessioni cloud. Alla prima chiedi un compito breve, alla seconda qualcosa che richieda un permesso, alla terza una domanda che finisca con "?". Entro 10 secondi la dashboard deve mostrare rispettivamente *Da rivedere*, *Ti aspetta (permesso)* e *Ti aspetta (domanda)*.
- **Confronto con i dati grezzi** (sul computer, serve Node ≥ 22.18, da una copia del repo):
  ```sh
  EVOFLOW_URL=… EVOFLOW_PASSWORD=<password della dashboard> node tools/check.ts --days 2
  ```
  Elenca le sessioni locali presenti nelle trascrizioni `~/.claude/projects` ma assenti dalla dashboard. Con `--listing file.json` confronta anche un elenco di sessioni cloud salvato da Claude.
- **Test dei 5 secondi**: apri la dashboard senza preparazione. Devi saper dire subito chi ti aspetta e perché.
