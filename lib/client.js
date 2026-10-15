// dsh-pylon-trae — BROWSER half: the plugin's settings card.
//
// WHAT THIS IS
//   Five blocks on the plugin's own settings pages: the account row (with a
//   switcher), the directory row (model count + a refresh button), the
//   「重建清单（只增不删）」 button, the credits row, and the check-in / model-probe
//   buttons. All of it consumes endpoints that already exist and were measured on
//   this machine (src/api.ts); nothing here invents a field.
//
// TWO BUTTONS, TWO DIFFERENT THINGS (the names say which)
//   「刷新目录」      POST /models/reload  — re-read the GATEWAY directory and replace
//                                          the plugin's in-memory list. Read-only:
//                                          no profile write, no provider seed.
//   「重建清单」      POST /models/refresh — the same re-read PLUS the only write this
//                                          card can trigger (add-new-only seed).
//   Confusing the two is a real defect, not a wording issue: the old 「刷新目录」
//   only re-read the plugin's own list (`GET /models`) while sounding like it went
//   to Trae. tools/client-bundle-check.mjs drives BOTH handlers through a stub
//   `fetch` and pins which endpoint each one reaches.
//
// LOADING CONTRACT (measured from the installed host bundles, not guessed)
//   window.__ModuleLoader__.load({ id, factory: (require) => exports })
//     * The page appends this file as a CLASSIC <script>. Any `import`/`export`
//       statement is therefore a syntax error — hence the CJS factory form.
//     * `id` MUST equal the package.json `name`. dsh-client-modules keys the boot
//       graph by PACKAGE NAME and materializes with `factories.get(<pkg name>)`;
//       any other id throws `no registered factory for "<pkg>"`
//       (dsh-client-modules/lib/client.js:671-676).
//     * `require` resolves PLATFORM SEED WORDS only (`react`, `react-dom`,
//       `react/jsx-runtime`) unless the package manifest lists the specifier; a
//       miss throws `require("<spec>") missed the module table` (…/client.js:696-706).
//       This card needs React and nothing else — no host client package is used,
//       which is why package.json declares `dsh.client.inject: []`.
//     * The factory is imported as a Cordis plugin module; only `apply` and
//       `inject` are read, extra exports are inert.
//   exports.inject = ["slots"] — the one client service this card uses.
//   ctx.slots.inject(KEY, () => ctx.slots.register({ name: KEY, key, priority }, Card))
//     * `plugins.bundle.config` and `plugins.row.config` are KEYED slots: `key` is
//       mandatory (dsh-client-ui-slots/lib/index.js:175-178) and the renderer binds
//       exactly one key per call: `renderSlot("plugins.bundle.config", …, { entryKey: pkg.name })`
//       and `renderSlot("plugins.row.config", …, { entryKey: rowConfigKey(pkg.name, row.rowId) })`
//       where `rowConfigKey = `${bundle}#${rowId}`` (dsh-client-ui-plugin-manager/
//       lib/client.js:27-29, :2390, :2401, :2522). Registering an extra key that
//       nobody renders is inert. Since the rename the two spellings the documents
//       used to distinguish — the specification's (`dsh-pylon-trae`) and the
//       installed package name — are the SAME string, so `BUNDLE_KEYS` and
//       `ROW_KEYS` each carry it twice; the second seat is recomputed from
//       `ROW_ID` so a future de-duplication that re-diverges them needs no edit here.
//
// WHY THE CARD TALKS TO THE HOST AND NOT TO THE LOOPBACK SHIM
//   The shim on 127.0.0.1:7864 is bearer-guarded and its token lives on disk. The
//   browser must never see that token, so it is not here (and there is no
//   localStorage/sessionStorage use either). Every call below is a same-origin
//   HTTP request to the plugin's OWN route on the host web server, mounted by
//   src/index.ts, where the host applies its Host/Origin fence plus browser
//   session authentication inside the handler.
//
// WHICH PATH: BOTH, `/api/...` FIRST
//   The host route is registered twice on purpose — `/plugins/dsh-pylon-trae` (what the
//   host answers directly) and `/api/plugins/dsh-pylon-trae` (the desktop app's UI layer
//   forwards only `/api/*` to the host; measured in this workspace, see the router
//   plugin's note at src/index.ts:1754-1764). A request that comes back WITHOUT
//   JSON (the proxy's own 403 page, a 404, a transport failure) did not reach our
//   handler, so the other prefix is tried once and the winner is remembered.
//
// HONEST STATES — the rule every block follows
//   loading / failure / empty are all rendered, the server's own `detail` is
//   printed verbatim (that is the safety net talking, not us), and no figure is
//   ever fabricated: "今日已领取" only ever comes from the server's answer, and
//   credits are printed under the gateway's own field names.
window.__ModuleLoader__.load({
	id: "dsh-pylon-trae",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const PKG = "dsh-pylon-trae";
		/** Row id this bundle declares in cordis.patch.yml (`- id: dsh-pylon-trae`). */
		const ROW_ID = "dsh-pylon-trae";
		const SLOT_BUNDLE = "plugins.bundle.config";
		const SLOT_ROW = "plugins.row.config";
		/** Same band as the two shipped sample cards (upstream trae card uses 30). */
		const CARD_PRIORITY = 30;
		/**
		 * Both key spellings, one seat each. After the rename to the unscoped
		 * `dsh-pylon-trae` the two spellings coincide, so both seats carry the same
		 * string — `BUNDLE_KEYS` is kept two-long on purpose: it is the INERT
		 * duplicate that proves the renderer still draws exactly one card.
		 * A keyed slot throws only for a duplicate (key, priority); that throw is
		 * caught per seat in `registerKeys`, so these coexist and the renderer binds
		 * one key.
		 */
		const BUNDLE_KEYS = [PKG, ROW_ID];
		const ROW_KEYS = [PKG + "#" + ROW_ID, ROW_ID + "#" + ROW_ID];

		/** Our own routes, in the order they are tried. Keep in sync with src/index.ts. */
		const ROUTE_BASE = ["/api/plugins/dsh-pylon-trae", "/plugins/dsh-pylon-trae"];
		/** Endpoints, relative to one route base. Exactly the ones src/api.ts serves. */
		const EP = {
			status: "/status",
			models: "/models",
			reload: "/models/reload",
			refresh: "/models/refresh",
			account: "/account",
			usage: "/usage",
			checkin: "/checkin",
			modelsTest: "/models/test"
		};
		/** How many models the probe button tests: bounded, stated on screen. */
		const PROBE_COUNT = 3;
		const CREDIT_ROWS_COLLAPSED = 6;

		/* ─────────────────────────── 小工具 ─────────────────────────── */
		function msg(error) {
			return error instanceof Error ? error.message : String(error);
		}
		function isObj(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function two(n) {
			return n < 10 ? "0" + String(n) : String(n);
		}
		/** Local wall-clock of an epoch-ms instant. Deterministic: no toLocaleString. */
		function formatClock(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "未知";
			const d = new Date(ms);
			return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
		}
		/** "剩 6 天 3 小时" / "已过期 2 天" — a duration, never a guess. */
		function formatLeft(untilMs, nowMs) {
			if (typeof untilMs !== "number" || !Number.isFinite(untilMs) || untilMs <= 0) return "未知";
			const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
			const deltaMs = untilMs - now;
			const past = deltaMs < 0;
			const minutes = Math.floor(Math.abs(deltaMs) / 60000);
			const days = Math.floor(minutes / 1440);
			const hours = Math.floor((minutes - days * 1440) / 60);
			const mins = minutes - days * 1440 - hours * 60;
			const body = days > 0 ? `${days} 天 ${hours} 小时` : hours > 0 ? `${hours} 小时 ${mins} 分` : `${mins} 分`;
			return past ? `已过期 ${body}` : `剩 ${body}`;
		}
		/** Numbers only: an unknown value renders as its own word, never "NaN". */
		function formatNumber(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "未知";
			if (Number.isInteger(value)) return String(value);
			return String(Number(value.toFixed(4)));
		}
		/** A server answer's own words, verbatim, or an explicit "nothing to show". */
		function detailOf(payload) {
			if (!isObj(payload)) return "";
			const detail = payload["detail"];
			return typeof detail === "string" ? detail : "";
		}
		function noop() {}

		/**
		 * The facts `GET /status` alone can tell the header and the directory row:
		 * the region, the loopback port, how many models the plugin is holding, and
		 * which account is currently billed. Pure, and the ONE place these are derived
		 * — both the hook and the offline check read them from here, so a hand-built
		 * scenario cannot disagree with a live one.
		 */
		function statusFacts(payload) {
			if (!isObj(payload)) return { region: "", port: undefined, modelCount: undefined, activeAccountId: "", accountWarning: "" };
			const accounts = Array.isArray(payload["accounts"]) ? payload["accounts"].filter(isObj) : [];
			const active = accounts.find((account) => account["active"] === true);
			const credential = isObj(payload["credential"]) ? payload["credential"] : undefined;
			const credentialId = credential === undefined ? undefined : credential["id"];
			return {
				region: typeof payload["region"] === "string" ? payload["region"] : "",
				port: typeof payload["port"] === "number" ? payload["port"] : undefined,
				modelCount: typeof payload["modelCount"] === "number" ? payload["modelCount"] : undefined,
				activeAccountId: active !== undefined && typeof active["id"] === "string" ? active["id"] : typeof credentialId === "string" ? credentialId : "",
				/**
				 * The server's own warning about the account this plugin bills, verbatim
				 * (「已选账号 X 在这台机器上不存在…」). `""` when there is nothing to say.
				 * It is printed, not interpreted: the plugin knows which account it fell
				 * back to and this card does not, so paraphrasing it could only lose the
				 * one fact that explains why the switcher and the bill disagree.
				 */
				accountWarning: typeof payload["accountWarning"] === "string" ? payload["accountWarning"] : "",
				/**
				 * The server's own verdict on the token deadline, `false` when it did not
				 * say. It carries the plugin's 60 s margin, which this card cannot
				 * recompute — the timestamp alone is not the same fact.
				 */
				credentialExpired: payload["credentialExpired"] === true
			};
		}

		/**
		 * The view-model's initial value, in ONE place.
		 *
		 * The hook seeds its blocks from this and tools/client-bundle-check.mjs builds
		 * every scenario from it, so the card's four states cannot drift apart from the
		 * states the offline check exercises.
		 */
		function emptyState() {
			return {
				status: { phase: "loading", detail: "", summary: { lines: [], accounts: [] }, payload: undefined },
				usage: { phase: "loading", detail: "", rows: [], expanded: false },
				checkin: { phase: "loading", detail: "", text: "", checkedIn: false },
				claim: { phase: "idle", text: "", tone: "" },
				rebuild: { phase: "idle", detail: "", summary: undefined },
				test: { phase: "idle", detail: "", lines: [] },
				busy: "",
				note: "",
				region: "",
				port: undefined,
				activeAccountId: "",
				accountWarning: "",
				credentialExpired: false,
				modelCount: undefined,
				directoryText: "",
				directoryDetail: "",
				onSelectAccount: noop,
				onRefreshDirectory: noop,
				onRebuild: noop,
				onClaim: noop,
				onTestModels: noop,
				onToggleCredits: noop
			};
		}

		/* ─────────────────────── 端点调用（双前缀） ─────────────────────── */
		/** The prefix that last answered with JSON. Module-scope: one per page. */
		let preferredBase = ROUTE_BASE[0];

		/**
		 * POST/GET one plugin endpoint.
		 *
		 * Returns `{ ok, payload }` where `ok` mirrors the server's own `ok` flag — a
		 * business refusal (`{ok:false, detail}`) is a normal answer and is NOT retried
		 * on the other prefix; only a response that is not JSON at all (i.e. never
		 * reached our handler) moves on to the next prefix.
		 */
		async function callApi(endpoint, options) {
			const opts = options || {};
			const method = opts.method || "GET";
			const init = {
				method,
				credentials: "same-origin",
				cache: "no-store",
				headers: { accept: "application/json" }
			};
			if (opts.body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(opts.body);
			}
			const tried = [preferredBase].concat(ROUTE_BASE.filter((base) => base !== preferredBase));
			/**
			 * Every URL that was tried and what each one actually answered. Kept because
			 * "没有返回 JSON" alone cost one live debugging round: it cannot tell a fence
			 * rejection (403, possibly on ONE spelling only) apart from a proxy page, a
			 * 404, or a dead transport. Per-path status codes are stated, never merged —
			 * `GET /status 失败：… →HTTP 403；… →HTTP 403` is a one-line diagnosis,
			 * whereas "没有返回 JSON" is a guess.
			 */
			const attempts = [];
			for (const base of tried) {
				let response;
				try {
					response = await fetch(base + endpoint, init);
				} catch (error) {
					attempts.push(`${base} →连接失败（${msg(error)}）`);
					continue;
				}
				const text = await response.text().catch(() => "");
				let payload;
				try {
					payload = text === "" ? undefined : JSON.parse(text);
				} catch {
					payload = undefined;
				}
				if (!isObj(payload)) {
					// 401/403 means the request DID reach something that decides access — the
					// host's fence, or the desktop app's proxy in front of it — and that layer
					// refused it. "被拒绝" is not the same claim as "没被转发", so it is not the
					// same sentence.
					const verdict = response.status === 401 || response.status === 403 ? "被拒绝" : "没有返回 JSON";
					attempts.push(`${base} →HTTP ${response.status}（${verdict}）`);
					continue;
				}
				preferredBase = base;
				return { ok: payload["ok"] === true, payload, httpStatus: response.status };
			}
			return {
				ok: false,
				payload: {
					ok: false,
					detail: `${method} ${endpoint} 失败，两条路都试过：${attempts.join("；")}`
				}
			};
		}

		/* ─────────────────────── 纯函数：把回答变成事实 ─────────────────────── */
		/** One account's label, from the credential/account record only. */
		function accountLabel(account) {
			if (!isObj(account)) return "未知账号";
			const name = account["accountName"];
			if (typeof name === "string" && name !== "") return name;
			const userId = account["userId"];
			if (typeof userId === "string" && userId !== "") return userId;
			return "未知账号";
		}
		function accountOrigin(account) {
			if (!isObj(account)) return "";
			const source = typeof account["source"] === "string" ? account["source"] : "";
			const edition = typeof account["edition"] === "string" ? account["edition"] : "";
			return [source, edition].filter((part) => part !== "").join(" · ");
		}
		/** The whole account block, derived from `GET /status`. */
		function statusSummary(payload) {
			if (!isObj(payload)) return { phase: "empty", lines: [], accounts: [], expired: false };
			const credential = isObj(payload["credential"]) ? payload["credential"] : undefined;
			if (credential === undefined) return { phase: "empty", lines: ["服务端没有返回凭据信息"], accounts: [], expired: false };
			const accounts = Array.isArray(payload["accounts"]) ? payload["accounts"].filter(isObj) : [];
			const expiresAtMs = typeof credential["expiresAtMs"] === "number" ? credential["expiresAtMs"] : 0;
			const expired = payload["credentialExpired"] === true;
			const lines = [
				`账号 ${accountLabel(credential)}`,
				`来源 ${accountOrigin(credential) || "未知"}`,
				`到期 ${formatClock(expiresAtMs)}（${formatLeft(expiresAtMs)}）`
			];
			const host = credential["host"];
			if (typeof host === "string" && host !== "") lines.push(`网关 ${host}`);
			// `expired` travels with the lines so the view can draw the 到期 line as a
			// warning without guessing: the deadline itself is only a timestamp, and
			// "the plugin considers this spent" is the server's call, not the card's.
			return { phase: "ready", lines, accounts, expired };
		}
		/**
		 * `POST /models/refresh` → what to print.
		 *
		 * `addedModels`/`keptModels`/`detail`/`reasons` are read from the nested
		 * `outcome` first and from the top level second: src/api.ts answers
		 * `{ ok, kind, modelCount, outcome }`, and `outcome` is the SeedOutcome.
		 * `no-guard` / `rolled-back` / `failed` print the server's own text unchanged
		 * — that is the write-path safety net speaking, and paraphrasing it would be
		 * the one thing this card must never do.
		 */
		function refreshSummary(payload) {
			if (!isObj(payload)) return { kind: "unknown", headline: "服务端没有可读的回答", lines: [], tone: "error" };
			const outcome = isObj(payload["outcome"]) ? payload["outcome"] : payload;
			const kind = typeof outcome["kind"] === "string" ? outcome["kind"] : typeof payload["kind"] === "string" ? payload["kind"] : "unknown";
			const lines = [];
			if (kind === "rebuilt") {
				const added = Array.isArray(outcome["addedModels"]) ? outcome["addedModels"].filter((id) => typeof id === "string") : [];
				const kept = outcome["keptModels"];
				lines.push(`保留 ${formatNumber(kept)} 个`);
				lines.push(added.length === 0 ? "新增 0 个（目录里没有从没提供过的模型）" : `新增 ${added.length} 个：${added.join("、")}`);
				const backup = outcome["backupPath"];
				if (typeof backup === "string" && backup !== "" && backup !== "(no write)") lines.push(`备份 ${backup}`);
				return { kind, headline: "已重建（只增不删）", lines, tone: "ok" };
			}
			if (kind === "created") {
				const count = outcome["modelCount"];
				lines.push(`首次写入，共 ${formatNumber(count)} 个模型`);
				return { kind, headline: "已生成供应商条目", lines, tone: "ok" };
			}
			if (kind === "present") return { kind, headline: "供应商已存在，未改动", lines, tone: "ok" };
			if (kind === "no-namespace" || kind === "no-guard" || kind === "failed") {
				const detail = typeof outcome["detail"] === "string" ? outcome["detail"] : detailOf(payload);
				return { kind, headline: "未写入", lines: [detail === "" ? "服务端没有给出原因" : detail], tone: "error" };
			}
			if (kind === "rolled-back") {
				const reasons = Array.isArray(outcome["reasons"]) ? outcome["reasons"].filter((r) => typeof r === "string") : [];
				const detail = typeof outcome["detail"] === "string" ? outcome["detail"] : "";
				if (detail !== "") lines.push(detail);
				for (const reason of reasons) lines.push(reason);
				if (reasons.length === 0 && detail === "") lines.push("服务端没有给出原因");
				const backup = outcome["backupPath"];
				if (typeof backup === "string" && backup !== "") lines.push(`已回滚，备份 ${backup}`);
				return { kind, headline: "写入导致配置丢失，已回滚", lines, tone: "error" };
			}
			const detail = detailOf(payload);
			return { kind, headline: `未识别的结果：${kind}`, lines: detail === "" ? [] : [detail], tone: "warn" };
		}
		/** `GET /usage` → rows under the gateway's OWN field names, in its own order. */
		function creditRows(payload) {
			if (!isObj(payload)) return [];
			const credits = payload["credits"];
			if (!isObj(credits)) return [];
			const rows = [];
			for (const name of Object.keys(credits)) {
				const value = credits[name];
				if (typeof value === "number" && Number.isFinite(value)) rows.push([name, value]);
			}
			return rows;
		}
		/** `GET /checkin` → the server's own verdict about today. */
		function checkinStatus(payload) {
			if (!isObj(payload)) return { phase: "empty", text: "服务端没有返回签到状态" };
			const credits = typeof payload["credits"] === "number" ? payload["credits"] : undefined;
			const reward = credits === undefined ? "" : ` · 今日奖励 ${formatNumber(credits)}`;
			if (payload["checkedIn"] === true || payload["didCheckedIn"] === true) {
				return { phase: "ready", checkedIn: true, text: `服务端状态：今日已领取${reward}` };
			}
			const enabled = payload["enabled"] === false ? "（该账号当前未开启签到）" : "";
			return { phase: "ready", checkedIn: false, text: `服务端状态：今日未领取${reward}${enabled}` };
		}
		/** `POST /checkin` → the claim's own answer. Never a local guess. */
		function claimSummary(payload) {
			if (!isObj(payload)) return { tone: "error", text: "服务端没有返回回答" };
			if (payload["claimed"] === true) return { tone: "ok", text: "已领取（服务端确认 claimed=true）" };
			const message = typeof payload["message"] === "string" ? payload["message"] : "";
			const code = typeof payload["code"] === "number" ? payload["code"] : undefined;
			const parts = ["服务端回答：未领取"];
			if (code !== undefined) parts.push(`code ${code}`);
			if (message !== "") parts.push(message);
			return { tone: "warn", text: parts.join(" · ") };
		}
		/** The wire verdicts src/api.ts can return, in Chinese, with the raw word kept. */
		const VERDICT_TEXT = {
			available: "可用",
			"needs-plan": "需要付费套餐",
			"not-served": "该通道不提供",
			"rate-limited": "被限流",
			"auth-rejected": "鉴权被拒",
			inconclusive: "无法判定"
		};
		function verdictText(verdict) {
			if (typeof verdict !== "string" || verdict === "") return "无法判定（服务端没有给 verdict）";
			const text = VERDICT_TEXT[verdict];
			return text === undefined ? `未知 verdict：${verdict}` : `${text}（${verdict}）`;
		}
		/** `POST /models/test` → one line per probed model. */
		function testLines(payload) {
			if (!isObj(payload)) return [];
			const results = Array.isArray(payload["results"]) ? payload["results"].filter(isObj) : [];
			return results.map((entry) => {
				const id = typeof entry["id"] === "string" ? entry["id"] : "未知模型";
				const detail = typeof entry["detail"] === "string" && entry["detail"] !== "" ? ` — ${entry["detail"]}` : "";
				return `${id}：${verdictText(entry["verdict"])}${detail}`;
			});
		}
		/**
		 * The directory row's own sentence: WHEN this panel last read the list.
		 *
		 * The COUNT is deliberately not part of it. The row already prints `模型 N 个`
		 * from the very same number, so spelling the count here too is what shipped
		 * `模型 79 个 · 模型 79 个 · 本面板上次读取 …` to the user. One number, one
		 * place; a number that is missing renders as 未知 rather than as a guess.
		 */
		function directoryReadAt(atMs) {
			return `本面板上次读取 ${formatClock(atMs)}`;
		}
		/** `GET /models` → the count and when WE read it (the server keeps no timestamp). */
		function modelsSummary(payload, atMs) {
			if (!isObj(payload)) return { phase: "empty", count: undefined, at: undefined, text: "服务端没有返回目录" };
			const models = Array.isArray(payload["models"]) ? payload["models"].filter(isObj) : [];
			return {
				phase: "ready",
				count: models.length,
				at: atMs,
				ids: models.map((model) => (typeof model["id"] === "string" ? model["id"] : "")).filter((id) => id !== ""),
				text: directoryReadAt(atMs)
			};
		}
		/**
		 * `POST /models/reload` → the count the plugin now holds, and when IT re-read
		 * the gateway. Read-only: no profile write happened, so nothing here reports
		 * one (`kind` / `outcome` belong to `/models/refresh`, not to this answer).
		 *
		 * `ids` stays EMPTY on purpose: the answer carries no `models` array, and the
		 * probe button re-reads `GET /models` when it needs ids rather than have the
		 * card pretend it still holds the list from before the reload.
		 *
		 * `at` is the server's own stamp (the moment the plugin's list became this
		 * count). A missing or unusable stamp stays `undefined` — the row then says
		 * 未知 instead of inventing a time.
		 */
		function reloadSummary(payload) {
			if (!isObj(payload)) return { phase: "empty", count: undefined, at: undefined, ids: [], text: "服务端没有返回目录" };
			const count = typeof payload["modelCount"] === "number" && Number.isFinite(payload["modelCount"]) ? payload["modelCount"] : undefined;
			const raw = payload["at"];
			const at = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
			return { phase: "ready", count, at, ids: [], text: directoryReadAt(at) };
		}

		/* ─────────────────────────── 样式 ─────────────────────────── */
		/** One stylesheet per package; the framework claims it by `data-plugin`. */
		const CARD_CSS_LABEL = PKG + "/TraeSettingsCard.css";
		const CARD_CSS = [
			".dtr-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}",
			".dtr-head{display:flex;align-items:center;gap:8px;min-width:0}",
			".dtr-title{font-weight:600}",
			".dtr-badge{margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".dtr-block{display:flex;flex-direction:column;gap:4px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l4)}",
			".dtr-blockTitle{font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".dtr-line{display:flex;align-items:flex-start;gap:6px;min-width:0}",
			".dtr-key{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:64px}",
			".dtr-value{min-width:0;overflow-wrap:anywhere}",
			".dtr-num{font-variant-numeric:tabular-nums}",
			".dtr-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
			".dtr-btn{flex:none;padding:3px 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}",
			".dtr-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".dtr-select{flex:none;max-width:100%;padding:2px 6px;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:12px}",
			".dtr-dim{color:var(--dsw-alias-label-tertiary)}",
			".dtr-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}",
			".dtr-warn{color:var(--dsw-alias-state-warn-primary,#b45309)}",
			".dtr-error{color:var(--dsw-alias-state-error-primary,#d92d20)}",
			".dtr-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}",
			".dtr-list{margin:0;padding-left:16px}",
			".dtr-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".dtr-link{border:0;background:0 0;padding:0;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;text-decoration:underline}"
		].join("");
		if (typeof document !== "undefined" && typeof document.createElement === "function") {
			const tag = document.createElement("style");
			// The framework claims untagged sheets for the materializing package and
			// later removes them by `style[data-plugin=<pkg>]`
			// (dsh-client-modules/lib/client.js:190-197, :492-498). Naming both
			// attributes keeps that bookkeeping true and gives the sheet a label.
			tag.setAttribute("data-plugin", PKG);
			tag.setAttribute("data-plugin-css", CARD_CSS_LABEL);
			tag.textContent = CARD_CSS;
			document.head.appendChild(tag);
		}

		/* ─────────────────────────── 渲染 ─────────────────────────── */
		function line(key, text, cls) {
			return h(
				"div",
				{ className: "dtr-line" },
				key === undefined ? null : h("span", { className: "dtr-key" }, key),
				h("span", { className: "dtr-value" + (cls === undefined ? "" : " " + cls) }, text)
			);
		}
		function stateLine(phase, text) {
			if (phase === "loading") return line(undefined, "读取中…", "dtr-dim");
			if (phase === "error") return line(undefined, text === "" ? "失败（服务端没有给出原因）" : text, "dtr-error");
			if (phase === "empty") return line(undefined, text === "" ? "（空）" : text, "dtr-dim");
			return null;
		}
		function block(title, children) {
			return h("div", { className: "dtr-block" }, h("div", { className: "dtr-blockTitle" }, title), children);
		}
		function button(label, onClick, disabled) {
			return h("button", { className: "dtr-btn", type: "button", onClick, disabled: disabled === true }, label);
		}

		/**
		 * The card's whole surface.
		 *
		 * Pure by construction: it renders one plain view-model, which is what makes
		 * every state (loading / failure / empty / ready) reachable from the offline
		 * check in tools/client-bundle-check.mjs without a browser.
		 */
		function TraeCardView(vm) {
			const status = vm.status;
			/* ① 账号行 */
			const accountChildren = [];
			if (status.phase !== "ready") {
				accountChildren.push(stateLine(status.phase, status.detail));
			} else {
				// The expiry line is the ONE line the server can declare a problem with
				// (`credentialExpired`, margin included), so it is the one line that can be
				// drawn as a warning. `statusSummary` builds that line itself, hence the
				// prefix test: the two live three lines apart and must not drift.
				for (const text of status.summary.lines) {
					const warn = status.summary.expired === true && text.indexOf("到期 ") === 0;
					accountChildren.push(line(undefined, text, warn ? "dtr-warn" : undefined));
				}
				// The server's account warning, verbatim and marked as a warning. Without
				// it, a selection that could not be honoured shows up only as the switcher
				// and the billed account disagreeing quietly.
				if (typeof vm.accountWarning === "string" && vm.accountWarning !== "") {
					accountChildren.push(line(undefined, vm.accountWarning, "dtr-warn"));
				}
				const accounts = status.summary.accounts;
				if (accounts.length === 0) {
					accountChildren.push(line(undefined, "本机只看到一个 Trae 安装（没有可切换的账号）", "dtr-dim"));
				} else {
					accountChildren.push(
						h(
							"div",
							{ className: "dtr-actions" },
							h(
								"select",
								{
									className: "dtr-select",
									// A controlled <select> whose value matches no <option> logs a React
									// warning, and the acceptance list says the console stays clean. With no
									// marked-active account the first row is the one drawn anyway, so it is
									// the value we hand React.
									value: vm.activeAccountId === "" && accounts.length > 0 ? accounts[0].id : vm.activeAccountId,
									disabled: vm.busy !== "" || accounts.length < 2,
									onChange: (event) => vm.onSelectAccount(event.target.value)
								},
								accounts.map((account) =>
									h(
										"option",
										{ key: String(account.id), value: account.id },
										`${accountLabel(account)}（${accountOrigin(account)}）${account.active === true ? " ←当前" : ""}`
									)
								)
							),
							accounts.length < 2 ? h("span", { className: "dtr-hint" }, "只有一个账号，切换不可用") : null
						)
					);
				}
			}

			/* ② 目录行 */
			const dirChildren = [];
			dirChildren.push(
				line(
					undefined,
					`模型 ${formatNumber(vm.modelCount)} 个${vm.directoryText === "" ? "" : ` · ${vm.directoryText}`}`
				)
			);
			dirChildren.push(
				h(
					"div",
					{ className: "dtr-actions" },
					button("刷新目录", vm.onRefreshDirectory, vm.busy !== ""),
					vm.directoryDetail === "" ? null : h("span", { className: "dtr-error" }, vm.directoryDetail)
				)
			);

			/* ③ 重建清单 */
			const refreshChildren = [
				h(
					"div",
					{ className: "dtr-actions" },
					button("重建清单（只增不删）", vm.onRebuild, vm.busy !== ""),
					h("span", { className: "dtr-hint" }, "只加从没提供过的新模型；你删掉的不复活")
				)
			];
			if (vm.rebuild.phase === "loading") refreshChildren.push(stateLine("loading", ""));
			else if (vm.rebuild.phase === "error") refreshChildren.push(stateLine("error", vm.rebuild.detail));
			else if (vm.rebuild.phase === "ready") {
				refreshChildren.push(line(undefined, vm.rebuild.summary.headline, vm.rebuild.summary.tone === "ok" ? "dtr-ok" : vm.rebuild.summary.tone === "error" ? "dtr-error" : "dtr-warn"));
				for (const text of vm.rebuild.summary.lines) {
					refreshChildren.push(h("div", { className: "dtr-value dtr-mono" }, text));
				}
			} else refreshChildren.push(line(undefined, "还没有重建过", "dtr-dim"));

			/* ④ 用量行 */
			const usageChildren = [];
			if (vm.usage.phase !== "ready") {
				usageChildren.push(stateLine(vm.usage.phase, vm.usage.detail));
			} else if (vm.usage.rows.length === 0) {
				usageChildren.push(line(undefined, "服务端没有返回任何额度字段（没有数字可显示）", "dtr-dim"));
			} else {
				const shown = vm.usage.expanded ? vm.usage.rows : vm.usage.rows.slice(0, CREDIT_ROWS_COLLAPSED);
				for (const [name, value] of shown) {
					usageChildren.push(line(name, formatNumber(value), "dtr-num"));
				}
				if (vm.usage.rows.length > CREDIT_ROWS_COLLAPSED) {
					usageChildren.push(
						h(
							"button",
							{ className: "dtr-link", type: "button", onClick: vm.onToggleCredits },
							vm.usage.expanded ? "收起" : `展开其余 ${vm.usage.rows.length - CREDIT_ROWS_COLLAPSED} 项`
						)
					);
				}
			}

			/* ⑤ 签到 / 测试 */
			const checkinChildren = [];
			if (vm.checkin.phase === "loading") checkinChildren.push(stateLine("loading", ""));
			else if (vm.checkin.phase === "error") checkinChildren.push(stateLine("error", vm.checkin.detail));
			else if (vm.checkin.phase === "ready") checkinChildren.push(line(undefined, vm.checkin.text, vm.checkin.checkedIn ? "dtr-ok" : ""));
			else checkinChildren.push(line(undefined, "还没有读取今日状态", "dtr-dim"));
			if (vm.claim.phase === "ready") checkinChildren.push(line(undefined, vm.claim.text, vm.claim.tone === "ok" ? "dtr-ok" : "dtr-warn"));
			if (vm.claim.phase === "error") checkinChildren.push(stateLine("error", vm.claim.text));
			checkinChildren.push(
				h(
					"div",
					{ className: "dtr-actions" },
					button("领取今日签到", vm.onClaim, vm.busy !== ""),
					h("span", { className: "dtr-hint" }, "会改变账号状态，只在你点击时发生")
				)
			);
			const testChildren = [
				h(
					"div",
					{ className: "dtr-actions" },
					button(`测试启用模型（前 ${PROBE_COUNT} 个）`, vm.onTestModels, vm.busy !== ""),
					h("span", { className: "dtr-hint" }, `会对 Trae 真发 ${PROBE_COUNT} 次极小请求，消耗少量额度`)
				)
			];
			if (vm.test.phase === "loading") testChildren.push(stateLine("loading", ""));
			else if (vm.test.phase === "error") testChildren.push(stateLine("error", vm.test.detail));
			else if (vm.test.phase === "ready") {
				if (vm.test.lines.length === 0) testChildren.push(line(undefined, "服务端没有返回任何 verdict", "dtr-dim"));
				else for (const text of vm.test.lines) testChildren.push(h("div", { className: "dtr-value dtr-mono" }, text));
			} else testChildren.push(line(undefined, `还没有测试过（将测试前 ${PROBE_COUNT} 个模型）`, "dtr-dim"));

			return h(
				"div",
				{ className: "dtr-card", "data-plugin-card": PKG },
				h(
					"div",
					{ className: "dtr-head" },
					h("span", { className: "dtr-title" }, "Trae（自建供应商）"),
					h("span", { className: "dtr-badge" }, `地区 ${vm.region === "" ? "未知" : vm.region} · 回环端口 ${formatNumber(vm.port)}`)
				),
				vm.note === "" ? null : line(undefined, vm.note, "dtr-warn"),
				block("① 账号", accountChildren),
				block("② 目录", dirChildren),
				block("③ 重建清单", refreshChildren),
				block("④ 用量（额度）", usageChildren),
				block("⑤ 签到 / 测试", checkinChildren.concat(testChildren))
			);
		}

		/* ─────────────────────────── 数据 ─────────────────────────── */
		/**
		 * The card's data hook. Read-only calls on mount (`/status`, `/usage`,
		 * `GET /checkin`); the calls that cost or write something (`POST /checkin`,
		 * `/models/test`, `/models/refresh`) only ever run from a click, while
		 * `POST /models/reload` — read-only on the server, but a real gateway
		 * round-trip — is likewise click-only.
		 */
		function useTraeCard() {
			const [status, setStatus] = React.useState(() => emptyState().status);
			const [usage, setUsage] = React.useState(() => emptyState().usage);
			const [checkin, setCheckin] = React.useState(() => emptyState().checkin);
			const [claim, setClaim] = React.useState(() => emptyState().claim);
			const [rebuild, setRebuild] = React.useState(() => emptyState().rebuild);
			const [test, setTest] = React.useState(() => emptyState().test);
			const [directory, setDirectory] = React.useState({ text: "", detail: "", ids: [], count: undefined });
			const [busy, setBusy] = React.useState("");
			const [note, setNote] = React.useState("");
			const alive = React.useRef(true);

			/**
			 * One click handler: refuses to touch state after unmount, and FORWARDS the
			 * arguments a control passes (the account `<select>` sends its new value).
			 */
			const guard = React.useCallback(
				(fn) => {
					return async (...args) => {
						if (!alive.current) return;
						await fn(...args);
					};
				},
				[]
			);

			const loadStatus = React.useCallback(async () => {
				const answer = await callApi(EP.status);
				if (!alive.current) return answer;
				if (!answer.ok) setStatus({ phase: "error", detail: detailOf(answer.payload) || "读取状态失败", summary: { lines: [], accounts: [] } });
				else setStatus({ phase: "ready", detail: "", summary: statusSummary(answer.payload), payload: answer.payload });
				return answer;
			}, []);
			const loadUsage = React.useCallback(async () => {
				const answer = await callApi(EP.usage);
				if (!alive.current) return;
				if (!answer.ok) setUsage((prev) => ({ ...prev, phase: "error", detail: detailOf(answer.payload) || "读取额度失败" }));
				else setUsage((prev) => ({ ...prev, phase: "ready", detail: "", rows: creditRows(answer.payload) }));
			}, []);
			const loadCheckin = React.useCallback(async () => {
				const answer = await callApi(EP.checkin);
				if (!alive.current) return;
				if (!answer.ok) setCheckin({ phase: "error", detail: detailOf(answer.payload) || "读取签到状态失败", text: "", checkedIn: false });
				else {
					const state = checkinStatus(answer.payload);
					setCheckin({ phase: state.phase === "ready" ? "ready" : "empty", detail: "", text: state.text, checkedIn: state.checkedIn === true });
				}
			}, []);

			React.useEffect(() => {
				alive.current = true;
				void loadStatus();
				void loadUsage();
				void loadCheckin();
				return () => {
					alive.current = false;
				};
			}, [loadStatus, loadUsage, loadCheckin]);

			/**
			 * 「刷新目录」 — `POST /models/reload`: the plugin re-reads the GATEWAY
			 * directory and replaces its in-memory list. Read-only on the server side
			 * (no profile write), which is the difference between this button and
			 * 「重建清单」 below; this handler never calls `/models/refresh`.
			 */
			const reloadDirectory = guard(async () => {
				setBusy("directory");
				setDirectory((prev) => ({ ...prev, detail: "" }));
				const answer = await callApi(EP.reload, { method: "POST", body: {} });
				if (!alive.current) return;
				if (!answer.ok) setDirectory((prev) => ({ ...prev, detail: detailOf(answer.payload) || "重新拉取目录失败" }));
				else {
					const summary = reloadSummary(answer.payload);
					// The number and the "上次读取" stamp both come from this answer: the
					// server just re-read the gateway, and its `modelCount` is the count
					// the plugin holds now.
					setDirectory({ text: summary.text, detail: "", ids: summary.ids, count: summary.count });
				}
				setBusy("");
			});

			/** `POST /models/refresh` — the only write this card can trigger. */
			const rebuildList = guard(async () => {
				setBusy("rebuild");
				setRebuild({ phase: "loading", detail: "", summary: undefined });
				const answer = await callApi(EP.refresh, { method: "POST", body: {} });
				if (!alive.current) return;
				if (!answer.ok) setRebuild({ phase: "error", detail: detailOf(answer.payload) || "重建失败（服务端没有给出原因）", summary: undefined });
				else setRebuild({ phase: "ready", detail: "", summary: refreshSummary(answer.payload) });
				setBusy("");
				await loadStatus();
			});

			/** `GET /models` then `POST /models/test` for a STATED, bounded count. */
			const testModels = guard(async () => {
				setBusy("test");
				setTest({ phase: "loading", detail: "", lines: [] });
				let ids = directory.ids;
				if (ids.length === 0) {
					const listed = await callApi(EP.models);
					if (!alive.current) return;
					if (listed.ok) {
						const summary = modelsSummary(listed.payload, Date.now());
						ids = summary.ids;
						setDirectory({ text: summary.text, detail: "", ids: summary.ids, count: summary.count });
					}
				}
				if (ids.length === 0) {
					setTest({ phase: "error", detail: "没有可测试的模型（目录为空或读取失败）", lines: [] });
					setBusy("");
					return;
				}
				const wanted = ids.slice(0, PROBE_COUNT);
				const answer = await callApi(EP.modelsTest, { method: "POST", body: { modelIds: wanted } });
				if (!alive.current) return;
				if (!answer.ok) setTest({ phase: "error", detail: detailOf(answer.payload) || "测试失败（服务端没有给出原因）", lines: [] });
				else setTest({ phase: "ready", detail: "", lines: testLines(answer.payload) });
				setBusy("");
			});

			const claimCheckin = guard(async () => {
				setBusy("claim");
				const answer = await callApi(EP.checkin, { method: "POST", body: {} });
				if (!alive.current) return;
				if (!answer.ok) setClaim({ phase: "error", text: detailOf(answer.payload) || "领取失败（服务端没有给出原因）", tone: "error" });
				else {
					const summary = claimSummary(answer.payload);
					setClaim({ phase: "ready", text: summary.text, tone: summary.tone });
				}
				setBusy("");
				await loadCheckin();
			});

			const selectAccount = guard(async (accountId) => {
				if (typeof accountId !== "string" || accountId === "") return;
				setBusy("account");
				setNote("");
				const answer = await callApi(EP.account, { method: "POST", body: { accountId } });
				if (!alive.current) return;
				if (!answer.ok) setNote(detailOf(answer.payload) || "切换账号失败");
				else setNote(`已切到 ${accountId}（服务端确认）`);
				setBusy("");
				await loadStatus();
			});

			const payload = status.payload;
			const facts = statusFacts(payload);
			// The directory row: a count read by the panel wins over the boot-time count,
			// because the panel's number is the one the operator just refreshed.
			const modelCount = directory.count !== undefined ? directory.count : facts.modelCount;

			return {
				status,
				usage,
				checkin,
				claim,
				rebuild,
				test,
				busy,
				note,
				region: facts.region,
				port: facts.port,
				activeAccountId: facts.activeAccountId,
				accountWarning: facts.accountWarning,
				modelCount,
				directoryText: directory.text,
				directoryDetail: directory.detail,
				onSelectAccount: selectAccount,
				onRefreshDirectory: reloadDirectory,
				onRebuild: rebuildList,
				onClaim: claimCheckin,
				onTestModels: testModels,
				onToggleCredits: () => setUsage((prev) => ({ ...prev, expanded: !prev.expanded }))
			};
		}
		/** The registered component: hooks, then the pure view. */
		function TraeCard() {
			return TraeCardView(useTraeCard());
		}

		/* ─────────────────────────── plugin face ─────────────────────────── */
		/**
		 * Register one card seat. A keyed slot throws on a duplicate (key, priority),
		 * so every seat is registered in its own `try`: a deployment that already has
		 * one of these keys loses one card, never the whole plugin.
		 */
		function registerKeys(ctx, slotName, keys) {
			for (const key of keys) {
				try {
					ctx.slots.inject(slotName, () =>
						ctx.slots.register(
							{
								name: slotName,
								key,
								priority: CARD_PRIORITY
							},
							TraeCard
						)
					);
				} catch (error) {
					console.warn("[" + PKG + "] card seat " + slotName + " / " + key + " not taken:", msg(error));
				}
			}
		}
		function apply(ctx) {
			registerKeys(ctx, SLOT_BUNDLE, BUNDLE_KEYS);
			registerKeys(ctx, SLOT_ROW, ROW_KEYS);
		}

		exports.apply = apply;
		/** The only client service this card needs. */
		exports.inject = ["slots"];
		// Exercised by tools/client-bundle-check.mjs. Inert to the Cordis Loader.
		exports.__internals = {
			PKG,
			ROW_ID,
			SLOT_BUNDLE,
			SLOT_ROW,
			CARD_PRIORITY,
			BUNDLE_KEYS,
			ROW_KEYS,
			ROUTE_BASE,
			EP,
			PROBE_COUNT,
			CREDIT_ROWS_COLLAPSED,
			CARD_CSS,
			CARD_CSS_LABEL,
			emptyState,
			statusFacts,
			useTraeCard,
			TraeCard,
			TraeCardView,
			formatClock,
			formatLeft,
			formatNumber,
			detailOf,
			accountLabel,
			accountOrigin,
			statusSummary,
			refreshSummary,
			creditRows,
			checkinStatus,
			claimSummary,
			verdictText,
			testLines,
			modelsSummary,
			reloadSummary,
			directoryReadAt,
			VERDICT_TEXT
		};

		return exports;
	}
});
