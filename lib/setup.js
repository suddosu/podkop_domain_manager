// Shared, copy-pasteable router setup script + short command descriptions,
// reused by the first-run wizard and the options page.

export const RELOAD_DESC = {
  restart:
    "restart — полный stop+start: dnsmasq, nftables, маршрутизация и sing-box пересоздаются вместе с конфигом. Именно так podkop применяет правки своего UCI (procd-триггер config.change → restart). По умолчанию: надёжно подхватывает новые/изменённые списки и привязки. Туннель на пару секунд блипает.",
  reload:
    "reload — облегчённый stop_main+start_main (для триггеров вроде «интерфейс поднялся»): без переустановки dnsmasq и без флага shutdown_correctly. В части сетапов оставляет лишние nft-правила маркировки → диагностика podkop не проходит, и нужен restart. Использовать осознанно.",
  list_update:
    "list_update — только обновить СОДЕРЖИМОЕ community/remote-списков (скачивание). Правки локальных файлов и привязок этим НЕ применяются.",
};

function aclJson(listDir) {
  return JSON.stringify({
    "podkop-domain-mgr": {
      description: "Podkop Domain Manager browser extension",
      read: {
        ubus: { session: ["access", "login"], uci: ["get"], file: ["read", "list", "stat"] },
        uci: ["podkop"],
        file: { [listDir]: ["read", "list"], [listDir + "/*"]: ["read", "list"] },
      },
      write: {
        ubus: { uci: ["set", "add", "delete", "commit"], file: ["write", "exec"] },
        uci: ["podkop"],
        file: {
          [listDir + "/*"]: ["write"],
          "/bin/mkdir": ["exec"],
          "/bin/rm": ["exec"],
          "/etc/init.d/podkop": ["exec"],
          "/usr/bin/podkop": ["exec"],
        },
      },
    },
  }, null, 2);
}

// Generates the full shell script to paste into the router's SSH terminal.
export function routerSetupScript({ user = "podkop-ext", listDir = "/etc/podkop-lists" } = {}) {
  return `# ===== Podkop Domain Manager — подготовка роутера (выполнять по SSH на РОУТЕРЕ) =====

# 1) Пакеты (один раз)
opkg update
opkg install uhttpd-mod-ubus rpcd rpcd-mod-file

# 2) ACL расширения
cat > /usr/share/rpcd/acl.d/podkop-domain-mgr.json << 'ACL'
${aclJson(listDir)}
ACL

# 3) Пользователь rpcd. ВАЖНО: пароль только ХЭШем (plaintext rpcd не принимает).
#    Этот же пароль (в открытом виде) вводишь в плагине.
PASS='ВАШ_ПАРОЛЬ'
uci add rpcd login
uci set rpcd.@login[-1].username='${user}'
uci set rpcd.@login[-1].password="$(uhttpd -m "$PASS")"
uci add_list rpcd.@login[-1].read='podkop-domain-mgr'
uci add_list rpcd.@login[-1].write='podkop-domain-mgr'
uci commit rpcd
/etc/init.d/rpcd restart

# 4) Каталог для файловых списков
mkdir -p ${listDir}

# 5) Проверка логина — должен вернуться "ubus_rpc_session"
curl -s http://127.0.0.1/ubus -d '{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","session","login",{"username":"${user}","password":"ВАШ_ПАРОЛЬ"}]}'
`;
}

// Re-hash password for an already-created login (fix for plaintext -> hash).
export function rehashScript({ user = "podkop-ext" } = {}) {
  return `PASS='ВАШ_ПАРОЛЬ'
idx=$(uci show rpcd | sed -n "s/^rpcd\\.@login\\[\\([0-9]*\\)\\]\\.username='${user}'/\\1/p")
uci set rpcd.@login[$idx].password="$(uhttpd -m "$PASS")"
uci commit rpcd
/etc/init.d/rpcd restart`;
}
