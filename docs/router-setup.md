# Подготовка роутера (OpenWrt + podkop ≥0.7) для Podkop Domain Manager

Плагин работает через **ubus поверх HTTP** (JSON-RPC). Отдельные доменные списки
делаются как **локальные plain-text файлы** в `/etc/podkop-lists/` (по одному домену
в строке) и подключаются в секцию через опцию **`local_domain_lists`** — podkop читает
их **прямо с диска**, без скачивания и без прокси (поэтому твой
`download_lists_via_proxy=1` им не мешает). Инлайновый `user_domains_text` плагин не трогает.

> Все команды — по SSH, один раз.

---

## 1. Пакеты

```sh
opkg update
opkg install uhttpd-mod-ubus rpcd rpcd-mod-file
```
- `uhttpd-mod-ubus` — эндпоинт `/ubus`;
- `rpcd` + **`rpcd-mod-file`** — методы `file.read/write/list/exec` (списки и reload).

---

## 2. Пользователь rpcd  ⚠️ ПАРОЛЬ ТОЛЬКО ХЭШЕМ

**Это и была причина `PERMISSION_DENIED`:** rpcd НЕ принимает пароль в открытом виде.
Пароль в `/etc/config/rpcd` должен быть crypt-хэшем (`$1$…`) или `$p$<systemuser>`.
В браузер ты вводишь обычный (plaintext) пароль — rpcd хэширует его и сравнивает.

ACL — создай `/usr/share/rpcd/acl.d/podkop-domain-mgr.json`:

```json
{
  "podkop-domain-mgr": {
    "description": "Podkop Domain Manager browser extension",
    "read": {
      "ubus": { "session": ["access", "login"], "uci": ["get"], "file": ["read", "list", "stat"] },
      "uci": ["podkop"],
      "file": { "/etc/podkop-lists": ["read", "list"], "/etc/podkop-lists/*": ["read", "list"] }
    },
    "write": {
      "ubus": { "uci": ["set", "add", "delete", "commit"], "file": ["write", "exec"] },
      "uci": ["podkop"],
      "file": {
        "/etc/podkop-lists/*": ["write"],
        "/bin/mkdir": ["exec"],
        "/bin/rm": ["exec"],
        "/etc/init.d/podkop": ["exec"],
        "/usr/bin/podkop": ["exec"]
      }
    }
  }
}
```

Пользователь — добавь в `/etc/config/rpcd` (подставь свой пароль в `uhttpd -m`):

```sh
PASS='ВАШ_ПАРОЛЬ'                     # этот же пароль вводишь в браузере
HASH="$(uhttpd -m "$PASS")"           # -> $1$...  (crypt MD5, rpcd это принимает)

uci add rpcd login
uci set rpcd.@login[-1].username='podkop-ext'
uci set rpcd.@login[-1].password="$HASH"
uci add_list rpcd.@login[-1].read='podkop-domain-mgr'
uci add_list rpcd.@login[-1].write='podkop-domain-mgr'
uci commit rpcd
/etc/init.d/rpcd restart
```

### Если логин уже создан с plaintext-паролем — просто перехэшируй:

```sh
PASS='ВАШ_ПАРОЛЬ'
idx=$(uci show rpcd | sed -n "s/^rpcd\.@login\[\([0-9]*\)\]\.username='podkop-ext'/\1/p")
uci set rpcd.@login[$idx].password="$(uhttpd -m "$PASS")"
uci commit rpcd
/etc/init.d/rpcd restart
```

**Проверка логина (должен вернуться `ubus_rpc_session`):**
```sh
curl -s http://127.0.0.1/ubus -d '{"jsonrpc":"2.0","id":1,"method":"call",
 "params":["00000000000000000000000000000000","session","login",
  {"username":"podkop-ext","password":"ВАШ_ПАРОЛЬ"}]}'
```
Если снова `"result":[6,...]` (PERMISSION_DENIED) — пароль не совпал: проверь, что в
браузере и в `uhttpd -m` он одинаковый, и что rpcd перезапущен. Логи: `logread | grep rpcd`.

---

## 3. Каталог для списков

```sh
mkdir -p /etc/podkop-lists
```
`/etc` персистентен (overlay), podkop читает файлы напрямую — раздавать по HTTP не нужно.
Никаких изменений в uhttpd и никакой возни с `download_lists_via_proxy`.

---

## 4. Установка расширения

1. `chrome://extensions` → **Режим разработчика** → **Загрузить распакованное** → папка `podkop-domain-manager`.
2. В попапе пройдёт мастер: адрес роутера, `podkop-ext`, пароль (plaintext) → шаг 2
   покажет найденные опции (`local_domain_lists`, `community_lists`, `user_domains_text` …)
   → шаг 3: каталог `/etc/podkop-lists`, команда применения `reload`.
3. Ошибки доступа к `/ubus` смотри на странице опций → «Проверить связь».

---

## Поведение под твою конфигурацию (v0.7.19)

- Секции `main` (vpn/awg10), `my_vps` (vpn/awg1), `vless` (proxy/urltest) подхватятся.
- Файловые списки = записи-пути в `local_domain_lists` секции; формат файла —
  **plain-text, по домену в строке** (НЕ srs/json — это формат remote-списков).
- Применение: плагин делает один `uci commit` (через ubus). rpcd сам шлёт
  `config.change`, и podkop по своему триггеру перезапускается ровно один раз —
  отдельный `restart` плагин НЕ выполняет (два перезапуска параллельно рвут nftables).
  Диагностику podkop можно запустить из плагина (вкладка «Проверки»).
- `user_domains_text` и `community_lists` — read-only, показываются и участвуют в
  проверке пересечений. Community-теги (`twitter`, `telegram`, `geoblock` …) plugin
  резолвит в домены, скачивая plain-text исходники из репозитория `itdoginfo/allow-domains`
  (вкладка «Пересечения» → «↻ community с GitHub»; кэш 24ч). Подсетевые теги
  (cloudflare/hetzner/ovh) — это IP-листы, для доменных пересечений помечаются как `subnet`.
  Источник — ветка `main`, может чуть отличаться от скомпилированного релиза `.srs`.

> Если созданные списки не появляются в выпадайке/вкладке «Списки» — почти всегда это
> ACL: нужна привилегия `file.list` на САМ каталог `/etc/podkop-lists` (строка
> `"/etc/podkop-lists": ["list"]`), а не только на `/etc/podkop-lists/*`.

## Безопасность

- Жёсткий whitelist на запись UCI: только `local_domain_lists`. Интерфейсы/прокси не правятся.
- Пароль rpcd хранится в `chrome.storage.local` без шифрования — отдельный пользователь
  с узким ACL (см. выше) это локализует.
