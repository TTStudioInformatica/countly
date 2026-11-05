# TT Analytics Tracking Standard v1 (`TT_TRACKING_STANDARD.md`)

Specifica ufficiale di tracciamento per tutte le applicazioni **TT Studio** (Web, iOS, Android, Backend) che inviano dati a **Countly Server (`v25.03.0`)** con il plugin **`tt-user-insights`**.

> **Principio Fondamentale**: Lo standard **TT Analytics Tracking Standard v1** **non modifica** il protocollo nativo di Countly (`/i`), ma definisce le convenzioni su identificazione utente, sessioni, schermate (`[CLY]_view`) e Custom Events affinché la **User Activity Timeline** di `tt-user-insights` possa ricostruire in modo fedele e leggibile ogni attività dell'utente.

---

## 1. Identificazione Utente dopo il Login (`device_id` e `user_details`)

In Countly ogni utente/dispositivo è identificato dal parametro `device_id` (da cui Countly calcola l'hash interno `uid` nella collection `app_users{app_id}`).

Al momento del **Login** (o all'avvio dell'app se l'utente è già autenticato):

1. Impostare (o unire tramite `change_id`) il `device_id` con l'identificativo univoco dell'utente applicativo (es. `USR-10492` o UUID utente).
2. Inviare i metadati anagrafici tramite `user_details` (`name`, `username`, `email`, `organization`, `phone` e `custom`).
3. Inviare l'evento business `user_login`.

### Esempio SDK Web Countly (verificato su `frontend/express/views/dashboard.html`)
```javascript
// 1. Inizializzazione SDK Countly
Countly.init({
    app_key: "YOUR_COUNTLY_APP_KEY",
    url: "https://analytics.ttstudio.it"
});

// 2. Avvio tracciamento automatico sessioni
Countly.q.push(['track_sessions']);

// 3. Al login dell'utente: associazione ID utente + invio user_details + evento user_login
function onUserLoginSuccess(user) {
    // Passa dal device_id anonimo all'ID utente reale unendo i dati (merge = true)
    Countly.q.push(['change_id', String(user.id), true]);

    // Salva i dettagli profilo in app_users{app_id}
    Countly.q.push(['user_details', {
        name: user.fullName,           // es. "Mario Rossi"
        username: user.username,       // es. "mrossi"
        email: user.email,             // es. "mario.rossi@azienda.it"
        organization: user.companyName,// es. "Rossi Giocattoli SRL"
        custom: {
            customer_type: user.customerType, // es. "B2B" | "B2C"
            price_list: user.priceListCode    // es. "LISTINO_GOLD"
        }
    }]);

    // Registra l'evento business di login nella timeline
    Countly.q.push(['add_event', {
        key: 'user_login',
        count: 1,
        segmentation: {
            method: 'credentials',
            customer_type: user.customerType
        }
    }]);
}
```

---

## 2. Tracciamento Sessioni (`begin_session`, `session_duration`, `end_session`)

Per permettere a `tt-user-insights` di raggruppare visivamente gli eventi sotto l'intestazione **`SESSIONE DD/MM/YYYY HH:mm - HH:mm`**:

- **SDK Web / Mobile**: abilitare il tracciamento sessioni nativo (`Countly.q.push(['track_sessions'])` su Web, oppure `beginSession()` / automatic session tracking negli SDK iOS/Android).
- **Chiamate HTTP `/i` dirette**:
  - Inizio sessione: `/i?app_key=...&device_id=...&begin_session=1`
  - Aggiornamento durata periodico (es. ogni 60s): `/i?app_key=...&device_id=...&session_duration=60`
  - Fine sessione: `/i?app_key=...&device_id=...&end_session=1&session_duration=48`

> **Nota Architetturale**: `tt-user-insights` associa gli eventi a una sessione **solo** quando Countly dispone di un `lsid` (`Last Session ID`) valido per quell'utente. Se l'app invia eventi senza aver mai avviato una sessione Countly, gli eventi vengono comunque mostrati nella timeline ma senza inventare un contenitore di sessione fittizio.

---

## 3. Tracciamento Schermate / Pagine (`[CLY]_view`) e Durata Reale (`dur`)

Countly traccia le schermate tramite l'evento riservato `[CLY]_view` in due fasi:
1. **Apertura schermata (`visit: 1`)**: quando l'utente entra nella schermata `Home`, l'SDK invia `[CLY]_view` con `segmentation: { name: "Home", visit: 1, segment: "Web" }`.
2. **Chiusura schermata (`dur`)**: quando l'utente passa a un'altra schermata (es. `Catalogo`) o chiude l'app, l'SDK calcola il tempo effettivo trascorso su `Home` e invia un secondo evento `[CLY]_view` (senza `visit: 1`) con `dur: 18` e `segmentation: { name: "Home" }`.

### Esempio SDK Web Countly
```javascript
// Quando l'utente apre la schermata "Home"
Countly.q.push(['track_pageview', 'Home']);

// Quando dopo 18 secondi l'utente naviga su "Catalogo",
// l'SDK Countly chiude automaticamente "Home" inviando dur: 18 e apre "Catalogo" con visit: 1
Countly.q.push(['track_pageview', 'Catalogo']);
```

> **Regola Rigorosa di `tt-user-insights`**: Se l'SDK non invia l'evento di chiusura con `dur > 0`, `tt-user-insights` mostra la schermata visitata (`Home`, `Catalogo`) **senza** il badge `permanenza`, evitando qualsiasi stima arbitraria `next_view_timestamp - previous_view_timestamp`.

---

## 4. Catalogo Eventi Standard (`TT Analytics Tracking Standard v1`)

Tutti gli eventi business vengono inviati come normali **Custom Events Countly** (`add_event` / `recordEvent`).

### 4.1 Autenticazione (`category: "authentication"`)

| Event Key | Descrizione | Proprietà `segmentation` supportate |
| :--- | :--- | :--- |
| `user_login` *(alias: `login`)* | Login utente effettuato | `method` (`"credentials"`, `"sso"`, `"biometric"`), `customer_type` (`"B2B"`, `"B2C"`) |
| `user_logout` *(alias: `logout`)* | Logout utente effettuato | `reason` (`"manual"`, `"session_expired"`) |

### 4.2 Ricerca e Filtri (`category: "search"` / `"catalog"`)

| Event Key | Descrizione | Proprietà `segmentation` supportate |
| :--- | :--- | :--- |
| `search_performed` | Ricerca nel catalogo | `query` *(string, **obbligatorio**)*, `results_count` *(integer, **obbligatorio**)*, `category` *(string, opz.)*, `filters` *(string JSON/testo, opz.)* |
| `filter_applied` | Applicazione filtro catalogo | `filter_name` *(string, **obbligatorio**)*, `filter_value` *(string, **obbligatorio**)*, `category` *(string, opz.)* |

#### Esempio SDK `search_performed`
```javascript
Countly.q.push(['add_event', {
    key: 'search_performed',
    count: 1,
    segmentation: {
        query: 'barbie camper',
        results_count: 32,
        category: 'Bambole',
        filters: 'brand:Mattel'
    }
}]);
```

### 4.3 Catalogo e Contenuti (`category: "catalog"`)

| Event Key | Descrizione | Proprietà `segmentation` supportate |
| :--- | :--- | :--- |
| `product_viewed` | Visualizzazione scheda prodotto | `sku` *(string, **obbligatorio**)*, `name` *(string, **obbligatorio**)*, `category` *(string)*, `brand` *(string)*, `price` *(number)* |
| `content_viewed` | Visualizzazione contenuto editoriale / promo / PDF | `content_id` *(string, **obbligatorio**)*, `title` *(string, **obbligatorio**)*, `content_type` *(string, es. `"catalog_pdf"`, `"banner"`, `"article"`)*, `category` *(string)* |

#### Esempio SDK `product_viewed`
```javascript
Countly.q.push(['add_event', {
    key: 'product_viewed',
    count: 1,
    segmentation: {
        sku: '83921',
        name: 'Barbie DreamHouse',
        category: 'Bambole',
        brand: 'Mattel',
        price: 249.90
    }
}]);
```

### 4.4 Carrello (`category: "cart"`)

| Event Key | Descrizione | Proprietà `segmentation` supportate |
| :--- | :--- | :--- |
| `cart_created` | Creazione nuovo carrello | `cart_id` *(string, **obbligatorio**)*, `customer_type` *(string)* |
| `product_added_to_cart` | Aggiunta articolo al carrello | `sku` *(string, **obbligatorio**)*, `name` *(string)*, `quantity` *(integer, **obbligatorio**)*, `price` *(number)*, `cart_id` *(string)* |
| `product_removed_from_cart` | Rimozione articolo dal carrello | `sku` *(string, **obbligatorio**)*, `name` *(string)*, `quantity` *(integer, **obbligatorio**)*, `cart_id` *(string)* |

#### Esempio SDK `product_added_to_cart`
```javascript
Countly.q.push(['add_event', {
    key: 'product_added_to_cart',
    count: 1,
    segmentation: {
        sku: '83921',
        name: 'Barbie DreamHouse',
        quantity: 2,
        price: 249.90,
        cart_id: 'CART-9012'
    }
}]);
```

### 4.5 Checkout e Ordini (`category: "order"`)

| Event Key | Descrizione | Proprietà `segmentation` supportate |
| :--- | :--- | :--- |
| `checkout_started` | Avvio procedura di checkout | `cart_id` *(string)*, `products_count` *(integer, **obbligatorio**)*, `amount` *(number, **obbligatorio**)* |
| `order_submitted` | Conferma e invio ordine | `order_id` *(string, **obbligatorio**)*, `products_count` *(integer, **obbligatorio**)*, `amount` *(number, **obbligatorio**)*, `currency` *(string, default `"EUR"`)*, `customer_type` *(string)* |
| `order_status_viewed` | Consultazione stato ordine | `order_id` *(string, **obbligatorio**)*, `status` *(string, **obbligatorio**)* |

#### Esempio SDK `order_submitted`
```javascript
Countly.q.push(['add_event', {
    key: 'order_submitted',
    count: 1,
    sum: 842.50,
    segmentation: {
        order_id: 'ORD-18527',
        products_count: 2,
        amount: 842.50,
        currency: 'EUR',
        customer_type: 'B2B'
    }
}]);
```

### 4.6 Errori Applicativi (`category: "error"`)

| Event Key | Descrizione | Proprietà `segmentation` supportate |
| :--- | :--- | :--- |
| `application_error` | Errore applicativo / API / validazione | `error_code` *(string, **obbligatorio**)*, `error_message` *(string, **obbligatorio**)*, `severity` (`"warning"`, `"error"`, `"fatal"`), `screen` *(string)* |
| `[CLY]_crash` | Crash nativo catturato da `Countly.log_error` / Crash Reporting | Catturato automaticamente dal parametro `/i?crash=...` (`name`, `error`, `type`, `view`, `nonfatal`) |

#### Esempio SDK `application_error`
```javascript
Countly.q.push(['add_event', {
    key: 'application_error',
    count: 1,
    segmentation: {
        error_code: 'ERP_SYNC_503',
        error_message: 'Servizio disponibilità magazzino temporaneamente non raggiungibile',
        severity: 'error',
        screen: 'Checkout'
    }
}]);
```

---

## 5. Regole di Sicurezza & Privacy per le App Client

1. **NON inviare mai credenziali o segreti** (`password`, `access_token`, `refresh_token`, `authorization`, `cvv`, `card_number`, `iban`) dentro `segmentation` o `user_details.custom`.
2. Anche in caso di errore umano lato client, `tt-user-insights` applica un filtro di **PII Redaction** (`validators.sanitizeEventSegments`) che maschera chiavi sensibili, JWT (`eyJ...`) e PAN di carte di pagamento con `"[REDACTED]"`.

