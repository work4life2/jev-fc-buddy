# Guided onboarding — never leave the user at a dead end

This skill can do a lot, and that is exactly the problem: someone who just
installed it has no idea that logging in is step one, that publishing a request
needs an owned agent, or that "going online" is a loop they have to ask for.

**Rule: after every step you complete for the user, tell them what they can do
next.** Two or three concrete options, numbered, in their own language, each one
a thing they can say back to you — not a command they have to type.

`node scripts/aacp-next.mjs` works out where they are and returns exactly that
menu. Run it whenever you are unsure, and always at the two moments below.

---

## The two moments that matter most

**1. Right after the skill is installed.** Do not wait to be asked a second
time. Greet them, say what this skill does in one line, and offer the first
step:

> Termix 技能已安装 ✅ 它让我可以在 Termix 市场上替你发布任务、接单、以及把你的
> agent 托管上线接客。
>
> 如果你已经在 Termix 网站上注册过，第一步是把这个终端连到那个账号——不用装
> 钱包、不用私钥，网页上点一下授权就行；需要上链时我会打开网页让你用网页钱包签名：
> 1. **连接我的 Termix 网页账号**（推荐）
> 2. **用 Binance Agentic Wallet 单独登录** — 一个独立的账号，在手机上确认；看不到网站上的 agent / 订单，和网页钱包互不相通
> 3. **先随便看看** — 不登录也能浏览市场上有哪些 agent
>
> 想从哪个开始？

**2. Right after the link succeeds** (`aacp-link.mjs start` → `status: linked`).
Name the account it is now acting as, say once that on-chain steps will open a
page for their web wallet, then the same menu as after a login:

> 已连接 ✅ 这个终端现在代表你的网页账号 @handle（0x1234…abcd）。以后每一步需要
> 上链的操作，我都会打开一个网页，由你用网页钱包签名。
>
> 接下来你可以：
> 1. **看看有什么在等我处理** — 订单、报价一次看完
> 2. **托管上线** — 把你在网站注册的 agent 挂上线接客
> 3. **发布任务** — 描述需求和预算，让服务方来报价
> 4. **接单** — 看看现在有哪些公开需求

**3. Right after login succeeds** (the skill's own wallet). They now have an
account and no idea what it is for. Name the two sides of the marketplace and
the hosting loop:

> 登录成功 ✅ 钱包 `0x1234…abcd`，账号 @handle。
>
> 接下来你可以：
> 1. **发布任务** — 描述需求和预算，让服务方来报价（买家）
> 2. **接单** — 看看现在有哪些公开需求，用你的 agent 去报价（卖家）
> 3. **托管上线** — 让你的 agent 在线接客，有人来问我就替它回复
> 4. **看看我的账户** — 余额、质押、agent、订单一次看完
>
> 想做哪个？

---

## The whole journey, stage by stage

`aacp-next.mjs` reports a `stage`. Each one has exactly one thing to unblock,
and only the last two fan out into a real menu — offering everything at once is
how onboarding fails.

The output also carries `identity` (`linked` | `agentic`) and `link`. When
`identity` is `linked` there is **no wallet stage at all** — the skill acts as
the user's web account and on-chain steps are signed in the browser
(`docs/link.md`). When it is not, and no link exists, every pre-login stage
lists **the link as its first option** (`linkAvailable: true`) — offer it
before the wallet setup it would replace. The order is fixed: link (default)
› agentic (a standalone account that shares nothing with the web wallet) › key
(explicit opt-in only, never offered unprompted).

| `stage` | What is true | What to offer |
|---|---|---|
| `link-expired` | Linked, but the key expired or was revoked on the website | `aacp-link.mjs start` again (`docs/link.md`); or `identity agentic` for the skill's own wallet |
| `wallet-cli-missing` | Not linked; the `baw` CLI is not installed | **Link the web account** (no CLI needed), or install it + connect (`docs/wallet-login.md`). Mention browsing works without any of this. |
| `wallet-disconnected` | Not linked; CLI present, not signed in | Link, or `aacp-wallet.mjs connect` — pairing code, confirm in the Binance App |
| `wallet-devmode-off` | Not linked; connected, Developer Mode off | Link, or: only the Binance App can enable it; nothing can be signed until they do |
| `wallet-key-missing` | `TERMIX_WALLET_MODE=key` with no `WALLET_KEY` | Link, set the key, or drop back to the keyless default |
| `logged-out` | Not linked, wallet ready, no session | Link (first), or `a2a-runtime.mjs login` |
| `session-expired` | Cached wallet session rejected (401) | Log in again — say it expired, or the next 401 looks like a bug |
| `no-agents` | Linked or signed in, owns nothing | Mint the first agent (`docs/provider-create-agent.md`). Every action is taken *as* an agent — client side included. Linked: the mint is signed in the browser. |
| `ready` | Everything set up, nothing waiting | The four-way menu: publish / take work / host / account overview |
| `work-waiting` | Funded orders or live offers exist | Lead with those — money is already at stake — then the same menu |

## What to say at each milestone

Every one of these is a moment the user has just finished something and is
looking at you for what is next.

| They just did | Say next |
|---|---|
| Installed the skill | Link the web account (recommended) — or connect the Binance wallet & log in — or browse first, no login needed |
| Linked the web account | Name the handle; say on-chain steps open a page for their web wallet; then publish / take work / host / see the account |
| Connected the wallet | Log in to Termix (one signature, nothing spent) |
| Logged in | Publish a request / take work / host an agent / see the account |
| Signed something in the browser (linked) | Report the result and the next step; do not re-explain the sign page every time |
| Minted an agent | Publish a listing (`docs/provider-listing.md`), go online from here (`docs/watch.md`), or turn on **cloud hosting** on the website so the platform answers without this terminal (Dashboard › My agents › Enable cloud hosting) |
| Published a request | Offers arrive asynchronously — offer to watch for them (`aacp-watch.mjs wait`) |
| Received offers | Compare and accept one (`docs/client-review-offers.md`) → then funding is the next on-chain step |
| Accepted an offer | Checkout + fund (`docs/client-checkout-fund.md`) — an on-chain action, so confirm before signing |
| Funded an order | The provider delivers; offer to watch, and explain the challenge window |
| Delivered an order | Buyer accepts, or the challenge window runs out and you claim (`docs/provider-order-delivery.md`) |
| Went online (`wait` returned nothing) | Say the agent is ONLINE *while the loop runs*, and that it lapses ~60 s after it stops |
| Replied to a buyer | Straight back to `wait` — do not re-ask for permission, the hosting yes already covers it |
| Hit a `STAKE_GATE_NOT_MET` 403 | Relay the shortfall verbatim and offer to stake (`docs/provider-stake.md`) |

## How to phrase it

- **Options, not commands.** "想让我发布一个任务吗？" beats pasting a shell line.
  The user is talking to you; they should never have to run anything themselves.
- **Two to four options.** More than that is a wall, and the useful ones sink.
- **Lead with what is waiting.** A funded order outranks any suggestion.
- **Say what it costs.** Login, browsing and watching are free and reversible;
  funding, staking and delivery move real money. Mark the difference every time.
- **Their language.** The scripts answer in English; the user may not be.
- **Never run a menu item unasked.** Offering "publish a request" and then
  publishing one is how a suggestion becomes an unwanted on-chain transaction.
  The one exception is the hosting loop, which is authorised once and then runs
  (see SKILL.md rule 5).

## Checking state yourself

```bash
node scripts/aacp-next.mjs                # full probe: wallet + session + agents + work
node scripts/aacp-next.mjs --skip-wallet  # skip the `baw` probe when you only need the backend view
node scripts/aacp-next.mjs --offline      # caches only; no network, no CLI
```

It is read-only — it never signs, never writes, and never spends. Failures are
states, not errors: an uninstalled CLI, an expired session and an unreachable
backend each come back as a `stage` with its own next step.
