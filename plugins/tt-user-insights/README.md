# TT User Insights (`tt-user-insights`)

Modulo proprietario della suite **TT Analytics** di **TT Studio**, progettato per **Countly Server (`v25.03.0`)** seguendo il principio **Zero Core Modification**.

> 🚀 **Nuovo sul progetto?** Inizia da **[`ONBOARDING.md`](./ONBOARDING.md)** per il percorso guidato di onboarding e la checklist rapida.

---

## 1. Panoramica Funzionale e User Activity Timeline

Il plugin **TT User Insights** aggiunge alla sezione **Analytics** di Countly una vista dedicata (`#/analytics/user-insights`) che consente a un operatore di selezionare un utente identificato/loggato e ricostruire l'intera **User Activity Timeline** in ordine cronologico:

1. **Ricerca Utente (`Find User`)**: ricerca istantanea su `app_users{app_id}` per `device_id` (`did`), `uid`, `name`, `email`, `username` o qualsiasi proprietà custom (`custom.<chiave>`).
2. **User Overview**: riepilogo dinamico del profilo utente (`name`, `username`, `email`, `deviceId`, `firstSeen`, `lastSeen`, `lastActivity`, `appVersion`, `os`, `device`, `country`/`city`, `customProperties`), mostrando solo i dati realmente disponibili.
3. **User Activity Timeline**:
   - Raggruppamento visivo per **Sessione** (`SESSIONE DD/MM/YYYY HH:mm - HH:mm`) quando il session ID Countly (`lsid` / `session_id`) è realmente e affidabilmente disponibile.
   - Supporto nativo per **4 tipi di record** (`SESSION`, `VIEW`, `TT_BUSINESS_EVENT`, `CUSTOM_EVENT`).
   - Gestione reale della **permanenza sulle schermate (`[CLY]_view`)**: supporta il meccanismo a 2 fasi degli SDK Countly (`visit: 1` all'apertura + evento `[CLY]_view` di chiusura con `dur`). Quando la durata non è inviata dall'SDK, **non viene mai simulata o calcolata per differenza tra timestamp**.
   - **Search Analytics (`search_performed`)**: estrazione strutturata di `query`, `results_count`, `category`, `filters` e filtro rapido **Searches (`Ricerche`)** con un click.
   - **BusinessEventRenderer estendibile**: traduce gli eventi dello standard **TT Analytics Tracking Standard v1** (vedi [`TT_TRACKING_STANDARD.md`](./TT_TRACKING_STANDARD.md)) e supporta qualsiasi custom event generico.
   - **Event Details Drawer**: vista **Business** separata dalla vista **Raw Event Data** (JSON originale Countly).
   - **Privacy & PII Redaction**: oscuramento automatico (`[REDACTED]`) di password, token, authorization header, JWT e PAN di carte di credito (verifica di Luhn) prima della persistenza e in fase di lettura.

---

## 2. Architettura del Plugin

```text
plugins/tt-user-insights/
├── package.json                                  # Metadati plugin Countly
├── config.js                                     # Configurazione (retention, PII redaction, tracking flags)
├── install.js                                    # Creazione indici MongoDB su tutte le app
├── uninstall.js                                  # Rimozione pulita delle collezioni del plugin
├── tests.js                                      # Suite test integrazione Countly (Mocha + Supertest)
├── README.md                                     # Documentazione tecnica e architetturale
├── TT_TRACKING_STANDARD.md                       # Specifica TT Analytics Tracking Standard v1 e guida SDK
├── api/
│   ├── api.js                                    # Entry point backend: hook Countly e route /o/tt-user-insights
│   ├── config/
│   │   └── businessEvents.js                     # Definizioni dichiarative TT Tracking Standard v1 e categorie
│   └── lib/
│       ├── eventRegistry.js                      # Registry estendibile per definizioni, recordType e custom renderer
│       ├── businessEventRenderer.js              # Layer BusinessEventRenderer (raw event -> business event)
│       ├── validators.js                         # Validazione input, NoSQL injection guard e PII Redaction
│       └── repository.js                         # Query MongoDB indicizzate, 2-phase view duration, session groups
├── frontend/
│   ├── app.js                                    # Entry point Express frontend
│   └── public/
│       ├── javascripts/
│       │   ├── countly.models.js                 # Store Vuex, localizzazione template e raggruppamento sessioni
│       │   └── countly.views.js                  # Componente Vue 2, BackboneWrapper, filtri e route
│       ├── templates/
│       │   └── main.html                         # Template UI (Search, Overview, Filters, Session Groups, Drawer)
│       ├── stylesheets/
│       │   ├── main.scss                         # Sorgente SCSS (BEM .cly-vue-tt-insights)
│       │   └── main.css                          # Foglio di stile compilato
│       └── localization/
│           ├── tt-user-insights.properties       # Localizzazione Inglese (default)
│           └── tt-user-insights_it.properties    # Localizzazione Italiana
└── test/
    └── unit.test.js                              # Suite di 21 test (18 scenari Fase 12) eseguibile con `node --test`
```

---

## 3. Performance, Collezioni MongoDB e Indici (Fase 10)

### Collezioni Utilizzate
1. `app_users{app_id}` (collezione nativa Countly, acceduta in sola lettura con proiezione `USER_PROJECTION` e arricchita via hook `/sdk/user_properties` quando l'SDK invia `user_details`).
2. `app_tt_user_events{app_id}` (collezione dedicata per-app creata dal plugin per memorizzare i singoli eventi atomici della timeline utente senza alterare le collezioni aggregate `events_data{app_id}` di Countly Core).

### Indici Creati su `app_tt_user_events{app_id}` (`ensureIndexesForApp`)
- `{ uid: 1, ts: -1 }`: indice primario per il caricamento paginato della timeline utente in ordine cronologico inverso.
- `{ did: 1, ts: -1 }`: lookup diretto per `device_id` (`did`).
- `{ uid: 1, cat: 1, ts: -1 }`: filtro combinato per utente + categoria (`authentication`, `navigation`, `search`, `catalog`, `cart`, `order`, `error`, `custom`) + range temporale.
- `{ uid: 1, key: 1, ts: -1 }`: filtro combinato per utente + `event_key` (incluso il filtro rapido `Searches` su `key: "search_performed"` e l'aggiornamento di durata su `[CLY]_view`).
- `{ uid: 1, rtype: 1, ts: -1 }`: filtro combinato per utente + `recordType` (`SESSION`, `VIEW`, `TT_BUSINESS_EVENT`, `CUSTOM_EVENT`).
- `{ uid: 1, sid: 1, ts: -1 }`: filtro e aggregazione per sessione Countly (`sid`).
- `{ cd: 1 }` con `expireAfterSeconds: retention_days * 86400` (default `180` giorni = `15.552.000` secondi): indice TTL nativo di MongoDB per il controllo automatico della cardinalità e dello spazio disco.

### PaginazioneObbligatoria
Tutte le query di lettura (`searchUsers` e `getUserTimeline`) applicano paginazione lato database (`.skip(skip).limit(limit)`) con `limit` massimo forzato a `100` record per pagina (`MAX_PAGE_LIMIT = 100` in `validators.js`).

---

## 4. Privacy, Sicurezza e PII Redaction (Fase 11)

- **Isolamento per App**: ogni richiesta valida `app_id` tramite `validators.validateAppId` (`/^[0-9a-fA-F]{24}$/`) e verifica i permessi di lettura dell'operatore tramite `rights.validateRead(params, "tt_user_insights", ...)` prima di interrogare esclusivamente `app_users{app_id}` e `app_tt_user_events{app_id}`.
- **Protezione NoSQL Injection**: tutti i parametri query (`uid`, `device_id`, `q`, `category`, `event_type`, `event_key`, `custom_key`) rifiutano oggetti, array e chiavi che iniziano con `$` o contengono `.` o chiavi di prototipo (`__proto__`, `constructor`, `prototype`).
- **PII Redaction (`validators.sanitizeEventSegments`)**:
  - Qualsiasi proprietà la cui chiave coincida o contenga termini sensibili configurati in `config.js` (`password`, `passwd`, `pwd`, `secret`, `token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apikey`, `authorization`, `auth_token`, `session_token`, `credit_card`, `card_number`, `cc_number`, `pan`, `cvv`, `cvc`, `csc`, `pin`, `iban`, `ssn`, `fiscal_code`, `private_key`) viene sostituita con `"[REDACTED]"`.
  - Qualsiasi valore stringa contenente token `Bearer ...`, **JWT** (`eyJ...`) o numeri di carta di pagamento (13–19 cifre che superano l'algoritmo di **Luhn**) viene mascherato automaticamente con `"[REDACTED]"`.

---

## 5. Endpoint API Esposti

| Metodo | Endpoint | Parametri Query Principali | Descrizione |
| :--- | :--- | :--- | :--- |
| `GET` | `/o/tt-user-insights/users` | `app_id` (req), `q`, `uid`, `device_id`, `email`, `name`, `custom_key`, `custom_value`, `skip`, `limit` | Ricerca paginata utenti nell'app corrente (`app_users{app_id}`). |
| `GET` | `/o/tt-user-insights/details` | `app_id` (req), `uid` oppure `device_id` | Restituisce il profilo completo (`User Overview`) di un singolo utente (`404` se inesistente). |
| `GET` | `/o/tt-user-insights/timeline` | `app_id` (req), `uid` o `device_id` (req), `from`, `to`, `category`, `event_type` (`SESSION`, `VIEW`, `TT_BUSINESS_EVENT`, `CUSTOM_EVENT`), `event_key`, `searches_only`, `session_id`, `q`, `skip`, `limit` | Restituisce `user`, `timeline`, `sessionGroups` e `pagination`. |
| `GET` | `/o/tt-user-insights/live` | `app_id` (req), `since_ts` (opz., cursore incrementale live), `category`, `event_type`, `event_key`, `errors_only`, `searches_only`, `q`, `limit` | **Live Events Stream (PostHog-inspired)**: flusso eventi in tempo reale di tutta l'applicazione arricchito con i profili utente (`displayName`, `uid`, `deviceId`). |
| `GET` | `/o/tt-user-insights/breadcrumbs` | `app_id` (req), `uid` o `device_id` (req), `before_ts` (req), `event_id` (opz.), `limit` (default `10`) | **Error & Event Breadcrumbs**: ricostruisce gli ultimi N passi eseguiti dall'utente immediatamente prima di un errore o evento. |
| `GET` | `/o/tt-user-insights/definitions` | `app_id` (req) | Restituisce le categorie e le definizioni di eventi registrate nel `EventRegistry`. |

---

## 6. Come Registrare Nuovi Business Events

```javascript
var ttUserInsights = require('../tt-user-insights/api/api.js');

ttUserInsights.registerEventDefinition({
    key: 'quote_requested',
    category: 'order',
    recordType: 'TT_BUSINESS_EVENT',
    icon: 'file-text',
    titleKey: 'tt-user-insights.event.quote_requested.title',
    descriptionKey: 'tt-user-insights.event.quote_requested.description',
    detailsKey: 'tt-user-insights.event.quote_requested.details',
    fields: [
        { prop: 'quote_id', labelKey: 'tt-user-insights.field.quote_id', format: 'string', primary: true },
        { prop: 'amount', labelKey: 'tt-user-insights.field.amount', format: 'currency', detail: true }
    ]
});
```

---

## 7. Come Attivare il Plugin ed Eseguire i Test

```bash
# Esecuzione Unit & Architectural Test Suite (21 test, zero dipendenze esterne)
node --test plugins/tt-user-insights/test/unit.test.js

# Abilitazione plugin su Countly Server
countly plugin enable tt-user-insights
countly upgrade
```
