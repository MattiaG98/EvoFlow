# EvoFlow

Una dashboard per lavorare con più agenti Claude Code in parallelo senza perdere il filo. Risponde in un colpo d'occhio a **chi ha bisogno di me adesso, e perché**, da iPhone, iPad e desktop.

- **Ti aspetta**: permessi da concedere, domande a cui rispondere, con il testo della domanda.
- **Dimenticata**: sessioni ferme in attesa da più di 48 ore.
- **Al lavoro**: cosa sta facendo ogni agente, con un avviso se tace da troppo tempo.
- **Mi sono perso**: un diario di un tocco, per misurare se la dashboard riduce davvero la dispersione.

I dati arrivano dagli hook di Claude Code (sessioni cloud e locali) e da una riconciliazione periodica con l'elenco ufficiale delle sessioni. Gira su Cloudflare Workers + D1, piano gratuito.

- **Messa in funzione:** [docs/SETUP.md](docs/SETUP.md)
- **Come funziona e cosa è verificato:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

```sh
npm run dev                                                    # http://localhost:8787, password "dev"
node tools/replay.ts tests/fixtures/scenario-demo.json --fast  # in un secondo terminale: dati demo
npm test
```
