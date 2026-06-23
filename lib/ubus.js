// Minimal ubus (OpenWrt) JSON-RPC over HTTP client.
// Endpoint: http(s)://<router>/ubus  (needs uhttpd-mod-ubus + rpcd + rpcd-mod-file)

const NULL_SESSION = "00000000000000000000000000000000";

const UBUS_STATUS = {
  0: "OK", 1: "INVALID_COMMAND", 2: "INVALID_ARGUMENT", 3: "METHOD_NOT_FOUND",
  4: "NOT_FOUND", 5: "NO_DATA", 6: "PERMISSION_DENIED", 7: "TIMEOUT",
  8: "NOT_SUPPORTED", 9: "UNKNOWN", 10: "CONNECTION_FAILED",
};

export class UbusError extends Error {
  constructor(code, method) {
    super(`ubus ${method}: ${UBUS_STATUS[code] || "code " + code}`);
    this.name = "UbusError";
    this.code = code;
    this.method = method;
  }
  get isAuth() { return this.code === 6; }
}

export class Ubus {
  constructor(base) {
    this.base = String(base).replace(/\/+$/, "");
    this.session = NULL_SESSION;
    this._id = 1;
    this.creds = null; // {user, pass} for auto-relogin
  }

  async _rpc(object, method, args) {
    let res;
    try {
      res = await fetch(this.base + "/ubus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: this._id++, method: "call",
          params: [this.session, object, method, args || {}],
        }),
      });
    } catch (e) {
      throw new Error(`Сеть/CORS: не достучались до ${this.base}/ubus (${e.message}). Проверь host_permissions и доступность роутера.`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} от ${this.base}/ubus`);
    const j = await res.json();
    if (j.error) throw new Error(`ubus rpc error: ${JSON.stringify(j.error)}`);
    const result = j.result;
    if (Array.isArray(result)) {
      const [code, data] = result;
      if (code !== 0) throw new UbusError(code, `${object}.${method}`);
      return data === undefined ? {} : data;
    }
    return result; // login on some builds returns object directly
  }

  // Auto-relogin once on PERMISSION_DENIED (expired session).
  async call(object, method, args) {
    try {
      return await this._rpc(object, method, args);
    } catch (e) {
      if (e instanceof UbusError && e.isAuth && this.creds && object !== "session") {
        await this.login(this.creds.user, this.creds.pass);
        return await this._rpc(object, method, args);
      }
      throw e;
    }
  }

  async login(user, pass, timeout = 600) {
    this.session = NULL_SESSION;
    const data = await this._rpc("session", "login", { username: user, password: pass, timeout });
    if (!data || !data.ubus_rpc_session) throw new Error("Login: не вернулся ubus_rpc_session (неверные логин/пароль?)");
    this.session = data.ubus_rpc_session;
    this.creds = { user, pass };
    return data;
  }

  // ---- uci ----
  async uciGetAll(config) { return (await this.call("uci", "get", { config })).values || {}; }
  async uciGet(config, section, option) {
    const r = await this.call("uci", "get", { config, section, option });
    return r.value;
  }
  async uciSet(config, section, values) { return this.call("uci", "set", { config, section, values }); }
  async uciCommit(config) { return this.call("uci", "commit", { config }); }

  // list helpers (ubus uci has no add_list/del_list -> read/modify/set whole array)
  async listAdd(config, section, option, value) {
    const arr = this._asArr(await this._optSafe(config, section, option));
    if (!arr.includes(value)) arr.push(value);
    await this.uciSet(config, section, { [option]: arr });
  }
  async listRemove(config, section, option, value) {
    const arr = this._asArr(await this._optSafe(config, section, option)).filter(v => v !== value);
    await this.uciSet(config, section, { [option]: arr });
  }
  async _optSafe(config, section, option) {
    try { return await this.uciGet(config, section, option); } catch { return undefined; }
  }
  _asArr(v) { return v == null ? [] : (Array.isArray(v) ? v.slice() : [v]); }

  // ---- file (rpcd-mod-file) ----
  async fileRead(path) { return (await this.call("file", "read", { path })).data; }
  async fileList(path) { return (await this.call("file", "list", { path })).entries || []; }
  async fileStat(path) { return this.call("file", "stat", { path }); }
  async exec(command, params = []) { return this.call("file", "exec", { command, params }); }

  // Chunked write to survive rpcd payload caps. mode is octal int.
  async fileWrite(path, data, mode = 0o644) {
    const CH = 3000;
    if (data.length === 0) { await this.call("file", "write", { path, data: "", mode }); return; }
    for (let i = 0; i < data.length; i += CH) {
      await this.call("file", "write", {
        path, data: data.slice(i, i + CH), append: i > 0, mode,
      });
    }
  }
}
