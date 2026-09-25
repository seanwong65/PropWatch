// 按揭計算機（共用）——首頁彈窗（index.html）同獨立頁（mortgage-calculator.html）
// 都用呢一份：官方數字 table、計數 pure function、表單 markup、render。
// ⚠️ 政府改印花稅／按保規定，淨係改呢個檔。獨立頁嘅「說明文字」（稅階表等）
//    係靜態 HTML（俾 Google 讀），改完數字記得對返 mortgage-calculator.html。
//
// 用嘅頁面要自己提供：
//   - #mc-form-host 容器（mountMortgageForm() 會將表單塞入去）
//   - useMcAsBudget(wan)：撳「用 X 萬做我嘅買盤預算」時做乜（每頁唔同）
//   - CSS：.vf-row2 .vf-label .vf-input .vf-submit .filter-chip 同 --brand 等 token

// ── 按揭計算機 ─────────────────────────────────────────────────
// 全部係 pure function，client-side 計，唔使 round trip（用戶逐個字打嗰陣
// 要即時出數）。三組官方數字擺喺呢度，改政策淨係改呢三個 table：
//   ① AVD_BANDS      印花稅（稅務局）
//   ② MIP_LTV        按揭成數上限（按證保險）
//   ③ MIP_PREMIUM    按揭保險保費率（按證保險）
// ⚠️ 每個 table 都寫住「數字幾時生效／邊度嚟」，因為呢啲嘢政府年年郁，
// 冇出處嘅話下次冇人知係咪過咗期。

// ① 從價印花稅（AVD）。2024-02-28 起 SSD／BSD／NRSD 全部撤銷，住宅買賣
//    淨係剩返 AVD 一項，所以呢度唔使再分首置／非首置。
//    現行稅階由 **2026-02-26** 起生效（>$1億 由 4.25% 上調至 6.5%），
//    另外 $400萬或以下 $100 嗰級係 2025 財政預算案落嘅。
//    來源：稅務局 https://www.ird.gov.hk/chi/faq/avd.htm
//    每級之間有「邊際寬免」band（例如 $4,000,001–$4,323,780 係
//    「$100 + 超出 $400萬嘅 20%」），作用係唔好一過界就跳一大舊稅。
const AVD_BANDS = [
  { max: 4000000,   flat: 100 },
  { max: 4323780,   base: 100,     over: 4000000,   pct: 0.20 },
  { max: 4500000,   rate: 0.015 },
  { max: 4935480,   base: 67500,   over: 4500000,   pct: 0.10 },
  { max: 6000000,   rate: 0.0225 },
  { max: 6642860,   base: 135000,  over: 6000000,   pct: 0.10 },
  { max: 9000000,   rate: 0.03 },
  { max: 10080000,  base: 270000,  over: 9000000,   pct: 0.10 },
  { max: 20000000,  rate: 0.0375 },
  { max: 21739120,  base: 750000,  over: 20000000,  pct: 0.10 },
  { max: 100000000, rate: 0.0425 },
  { max: 109574470, base: 4250000, over: 100000000, pct: 0.30 },
  { max: Infinity,  rate: 0.065 },
];
function stampDuty(price) {
  if (!(price > 0)) return 0;
  const b = AVD_BANDS.find(x => price <= x.max);
  if (b.flat != null) return b.flat;
  if (b.rate != null) return Math.round(price * b.rate);
  return Math.round(b.base + (price - b.over) * b.pct);
}

// ② 最高按揭成數。金管局基本上限係 **70%**；要借更高就要買按揭保險，
//    按證保險再按樓價封頂（下表）。90% 嗰級仲有兩個條件：申請時名下冇
//    任何香港住宅物業，而且全部申請人係固定受薪人士。
//    ⚠️ $1,715萬–$3,000萬 嗰級（70%）而家淨係適用於 2024-10-16 之前簽
//    臨約嘅個案，所以新買入嘅樓，按保實際去到 $1,715萬 就封頂，之後
//    只可以做金管局嘅 70%。
//    來源：按證保險 https://www.hkmc.com.hk/chi/our_business/mortgage_insurance_programme.html
const HKMA_BASE_LTV = 0.70;
function maxLoanFor(price, firstTime) {
  if (!(price > 0)) return 0;
  const hi = firstTime ? 0.90 : 0.80;
  if (price <= 10000000) return price * hi;
  if (price <= 11250000) return Math.min(price * hi, 9000000);   // 貸款上限 $900萬
  if (price <= 15000000) return price * 0.80;
  if (price <= 17150000) return Math.min(price * 0.80, 12000000); // 貸款上限 $1,200萬
  return price * HKMA_BASE_LTV;
}

// ③ 按揭保險保費（一次付清、浮息按揭）。單位＝貸款額嘅百分比。
//    key = 保險範圍「70%以上至 X%」；每個 X 之下再按還款年期分。
//    表1 樓價 ≤$600萬 首置 ／ 表2 ≤$600萬 非首置 ／ 表3 ≤$1,500萬 首置 ／
//    表4 ≤$1,715萬（不分首置，只到 80%）。
//    來源：按證保險「按揭保費一覽表」2024 年 10 月版
//    https://www.hkmc.com.hk/files/product_file/3/1398/Premium%20Rate%20Sheet_Chi_clean_16102024.pdf
//    註：官方仲有「定息按揭」同「每年支付」嘅版本，同埋畀有未供完按揭
//    嘅申請人用嘅 60%-起 表。呢度只做最常見嗰個組合（浮息＋一次付清＋
//    新買樓），計出嚟係估算。
const MIP_TENORS = [10, 15, 20, 25, 30];
const MIP_PREMIUM = {
  t1: { 75: [0, 0, 0, 0, 0],
        80: [0.50, 0.60, 0.76, 0.83, 0.92],
        85: [0.86, 1.02, 1.25, 1.35, 1.41],
        90: [1.25, 1.48, 1.79, 2.03, 2.16] },
  t2: { 75: [0.15, 0.15, 0.15, 0.15, 0.15],
        80: [0.65, 0.75, 0.91, 0.98, 1.07] },
  t3: { 75: [0, 0, 0, 0, 0],
        80: [0.60, 0.71, 0.90, 0.97, 1.09],
        85: [1.01, 1.20, 1.46, 1.57, 1.64],
        90: [1.46, 1.72, 2.08, 2.35, 2.50] },
  t4: { 75: [0.15, 0.15, 0.15, 0.15, 0.15],
        80: [0.75, 0.86, 1.05, 1.12, 1.24] },
};
function mipTableFor(price, firstTime) {
  if (firstTime && price <= 6000000) return "t1";
  if (firstTime && price <= 15000000) return "t3";
  if (price <= 6000000) return "t2";
  return "t4";                                    // ≤$1,715萬，只做到 80%
}
// 保費：LTV 落喺邊個「保險範圍」就用嗰級（例：82% → 「70%以上至85%」）。
// 年期唔喺表上就取上一個檔（22 年當 25 年計）——寧願報大唔好報細。
function mipPremium(price, loan, years, firstTime) {
  if (!(price > 0) || !(loan > 0)) return { rate: 0, amount: 0, ok: true };
  const ltv = loan / price;
  if (ltv <= HKMA_BASE_LTV + 1e-9) return { rate: 0, amount: 0, ok: true };
  if (price > 17150000) return { rate: 0, amount: 0, ok: false, why: "樓價超過 $1,715萬，按保唔做，最多只可以借 7 成" };
  const tbl = MIP_PREMIUM[mipTableFor(price, firstTime)];
  const tier = [75, 80, 85, 90].find(x => ltv <= x / 100 + 1e-9);
  const row = tier && tbl[tier];
  if (!row) return { rate: 0, amount: 0, ok: false, why: "呢個樓價／成數組合按保唔接" };
  const ti = MIP_TENORS.findIndex(t => years <= t);
  const rate = row[ti < 0 ? MIP_TENORS.length - 1 : ti];
  return { rate, amount: Math.round(loan * rate / 100), ok: true, tier };
}

// 每月供款（等額本息）。利率 0 都要計得掂（純除年期），唔好出 NaN。
function monthlyPayment(loan, annualRatePct, years) {
  const n = Math.round(years * 12);
  if (!(loan > 0) || !(n > 0)) return 0;
  const i = annualRatePct / 100 / 12;
  if (i <= 0) return loan / n;
  return loan * i / (1 - Math.pow(1 + i, -n));
}
// 反過嚟：一個月供得起咁多，最多可以借幾多
function loanFromPayment(payment, annualRatePct, years) {
  const n = Math.round(years * 12);
  if (!(payment > 0) || !(n > 0)) return 0;
  const i = annualRatePct / 100 / 12;
  if (i <= 0) return payment * n;
  return payment * (1 - Math.pow(1 + i, -n)) / i;
}

// 雜費：呢兩項冇官方公價（同印花稅／按保唔同，冇得照抄），所以做成
// 可改嘅輸入，預設值只係起步點。代理佣金行業慣例 1%（中原、28Hse 兩個
// 計算機都係 1%）。律師費各行各異——實測 28Hse 用 $600萬→$32,500、
// $800萬→$37,500（跟樓價滑），一般轉手樓買賣＋按揭報價則低到 $8,000–
// $15,000，差好遠，所以唔好扮準，畀用戶入返律師行報嘅價。
const MC_AGENT_PCT_DEFAULT = 1;
const MC_LEGAL_FEE_DEFAULT = 15000;
// 裝修費預留冇市場慣例（各人裝修預算差好遠），預設 0——留空即係「未計」，
// 唔好幫用戶估一個數出嚟誤導佢。
// DSR（供款與入息比率）上限 50%，2024-10-16 起劃一（唔再分自住/收租、
// 首置/非首置）。壓力測試（+2% 加息測試）已經喺 2025-02-28 取消。
const DSR_CAP = 0.50;

// 花紅計入月入：呢個唔係官方規定（金管局冇訂實點計花紅，係銀行自己決
// 定），係市場慣例，各行做法都唔一樣。跟返最常見嘅做法：
//   月入貢獻 = 最近兩年花紅平均 ÷ 12，但封頂喺「底薪嘅 3 倍」。
// 封頂嘅原意：如果淨係一年有花紅（例如轉工前一年冇），除 24 個月會計得
// 太少見唔到真實水平；但花紅／佣金大到成幾廿萬，銀行都唔會照單全收，
// 3 倍封頂係業界常見嘅風控線。
// 來源：市場慣例（星之谷／HK01），唔係監管要求，所以呢度只做估算，
// 實際銀行點計以佢哋審批為準。
const BONUS_LTM_CAP_X_SALARY = 3;
function bonusMonthlyIncome(baseSalary, bonusYear1, bonusYear2) {
  const b1 = bonusYear1 || 0, b2 = bonusYear2 || 0;
  const avgMonthly = (b1 + b2) / 24;
  const cap = (baseSalary || 0) * BONUS_LTM_CAP_X_SALARY / 12;
  return Math.min(avgMonthly, cap);
}

// 由樓價計：一次過出晒「月供 / 首期 / 印花稅 / 按保 / 雜費 / 總現金」。
// ltv 同 loan 揀一個俾：ltv = 「我想做幾成」，loan = 「我實際要借咁多」
// （倒推嗰邊用，因為嗰度個貸款額係由「樓價減埋手頭現金」倒出嚟）。
// maxLtv：出租盤用——按揭保險淨係批自住（見立法會 2025-07-09 答覆，得
// 三種特殊情況先俾自住盤出租，一般收租盤申請時已經要如實聲明用途），
// 一敍做就冇按保，封晒喺金管局基本上限 70%。傳呢個入嚟就強制用 70%，
// 唔理 firstTime／樓價分級，亦唔使計 mip（≤70% 本身就係 0）。
function mortgageBreakdown({ price, ltv, loan: wantLoanIn, years, rate, firstTime, agentPct, legalFee, renoFee, maxLtv }) {
  const aPct = (agentPct != null ? agentPct : MC_AGENT_PCT_DEFAULT) / 100;
  const legal = legalFee != null ? legalFee : MC_LEGAL_FEE_DEFAULT;
  const reno = renoFee || 0;
  const wantLoan = wantLoanIn != null ? wantLoanIn : price * ltv;
  const capLoan = maxLtv != null ? price * maxLtv : maxLoanFor(price, firstTime);
  const loan = Math.min(wantLoan, capLoan);
  const capped = wantLoan - loan > 1;           // 想借嘅多過批得到
  const mip = maxLtv != null && maxLtv <= HKMA_BASE_LTV + 1e-9
    ? { rate: 0, amount: 0, ok: true }
    : mipPremium(price, loan, years, firstTime);
  const down = price - loan;
  const duty = stampDuty(price);
  const agent = Math.round(price * aPct);
  const pay = monthlyPayment(loan, rate, years);
  return {
    price, loan, down, capped, capLoan,
    ltv: price > 0 ? loan / price : 0,
    duty, agent, legal, reno, mip,
    monthly: Math.round(pay),
    // 按保保費銀行通常可以「加入貸款額」分期還，但預設當現金支出——
    // 報大個現金需求好過報細，用戶唔會因為呢個數而畀唔到訂。裝修費本身
    // 就係「使費」，用戶主動預留就即刻計入去，唔洗做行業慣例。
    cashNeeded: Math.round(down + duty + agent + legal + reno + mip.amount),
    incomeNeeded: Math.round(Math.round(pay) / DSR_CAP),
  };
}

// 由「月入 + 手頭現金」倒推買得起幾錢樓。
// 用二分法而唔用公式：按揭成數上限、印花稅、按保費率三樣都係分段函數，
// 夾埋冇 closed form，二分法穩陣好多（單調遞增，60 次已經準到蚊都飛唔甩）。
// maxLtv：出租盤場景用，見 mortgageBreakdown 頂嗰段註解——傳咗就即刻封
// 死喺嗰個成數（一般 0.70），冧晒按揭保險嗰套「解費率」邏輯，因為出租盤
// 根本冚唔到保險，唔使諗邊個檔。
function affordability({ income, cash, years, rate, firstTime, agentPct, legalFee, renoFee, maxLtv }) {
  const budget = income * DSR_CAP;
  const aPct = (agentPct != null ? agentPct : MC_AGENT_PCT_DEFAULT) / 100;
  const legal = legalFee != null ? legalFee : MC_LEGAL_FEE_DEFAULT;
  const reno = renoFee || 0;
  const noInsurance = maxLtv != null && maxLtv <= HKMA_BASE_LTV + 1e-9;

  // 一個樓價要借幾多＝樓價減「手頭現金用晒喺首期之後仲剩幾多」。
  // ⚠️ 呢度千其唔可以當「一律做盡九成」——手頭現金多過首期嘅人（例如
  //    有 $500萬 現金），逼佢借盡就會白白嘥咗啲現金，倒推出嚟嘅樓價會
  //    細成一大截（實例：$500萬現金 + 月入 $5萬，借盡九成計出 $618萬，
  //    但其實用晒啲現金買到 $1,000萬）。所以係「用晒現金，爭幾多借幾多」。
  // 按保保費本身係貸款額嘅百分比，而個費率又睇貸款額落喺邊個成數檔——
  // 互相依賴。⚠️ 呢度**唔可以用迭代逼近**：費率係階梯函數，會喺兩個檔
  // 之間左右跳唔收斂（實測 89.99% ⇄ 91.94% 跳足六轉），而且最後嗰轉用嘅
  // 費率同真正個貸款額對唔上，出嚟嘅「要準備嘅現金」會爆過手頭現金。
  // 改為直接解方程：假設費率係 r，loan = (樓價 − 現金 + 雜費) / (1 − r)，
  // 逐個可能嘅 r 解一次，再驗返個 loan 真係落返 r 嗰個檔先當有效解。
  // 出租盤冇保險可解（一定係 r=0），一條直線方程搞掂，唔使查 MIP 表。
  const loanFor = (price) => {
    // 裝修費預留同律師費一樣係「用手頭現金找數」嘅雜費——你有幾多現金
    // 落首期，係手頭現金扣走裝修費之後嗰筆，唔係樓價嘅一部分。
    const fixed = stampDuty(price) + Math.round(price * aPct) + legal + reno;
    const need = price - cash + fixed;          // 未計按保之前要借幾多
    if (need <= 0) return 0;                    // 現金夠晒，唔使做按揭
    if (noInsurance) return need;
    const tbl = MIP_PREMIUM[mipTableFor(price, firstTime)];
    const ti = MIP_TENORS.findIndex((t) => years <= t);
    const tix = ti < 0 ? MIP_TENORS.length - 1 : ti;
    const cands = [0, ...Object.keys(tbl).map((k) => tbl[k][tix])];
    let best = null;
    for (const r of cands) {
      const loan = need / (1 - r / 100);
      const p = mipPremium(price, loan, years, firstTime);
      if (!p.ok || Math.abs(p.rate - r) > 1e-9) continue;   // 個 loan 唔落返 r 嗰個檔
      if (best == null || loan < best) best = loan;
    }
    return best != null ? best : Infinity;      // 冇自洽解 → 下面 fits() 會拒絕
  };
  const capFor = (price) => (maxLtv != null ? price * maxLtv : maxLoanFor(price, firstTime));
  const fits = (price) => {
    const loan = loanFor(price);
    if (loan > capFor(price) + 1) return false;                                    // 成數過唔到
    if (!noInsurance && !mipPremium(price, loan, years, firstTime).ok) return false; // 按保唔接
    return monthlyPayment(loan, rate, years) <= budget;                            // 供唔起
  };
  if (!(income > 0) || !(cash > 0) || !fits(500000)) return null;
  let lo = 500000, hi = 500000;
  while (hi < 2e8 && fits(hi)) hi *= 2;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  const price = Math.floor(lo / 10000) * 10000;   // 收到「萬」位，唔好出零頭
  return { price, ...mortgageBreakdown({ price, loan: loanFor(price), years, rate, firstTime, agentPct, legalFee, renoFee, maxLtv }),
           // 邊樣夾住咗？講返俾用戶知先有用（唔夠現金 vs 唔夠人工 vs 成數上限）
           bind: (() => {
             const p2 = price * 1.02, l2 = loanFor(p2);
             if (monthlyPayment(l2, rate, years) > budget) return "income";
             if (l2 > capFor(p2) + 1) return "ltv";
             return "cash";
           })() };
}


// ── 按揭計算機 UI ──────────────────────────────────────────────
let _mcMode = "afford";       // afford = 由入息倒推；cost = 由樓價計
let _mcFtb = true;

function setMcMode(m) {
  _mcMode = m;
  document.getElementById("mc-tab-afford").classList.toggle("active", m === "afford");
  document.getElementById("mc-tab-cost").classList.toggle("active", m === "cost");
  document.getElementById("mc-pane-afford").style.display = m === "afford" ? "" : "none";
  document.getElementById("mc-pane-cost").style.display = m === "cost" ? "" : "none";
  renderMortgage();
}
function setMcFtb(btn) {
  _mcFtb = btn.dataset.ftb === "1";
  document.querySelectorAll("#mc-ftb .filter-chip").forEach(b => b.classList.toggle("active", b === btn));
  renderMortgage();
}
function toggleMcBonus() {
  const box = document.getElementById("mc-bonus-box");
  const open = box.style.display === "none";
  box.style.display = open ? "" : "none";
  document.getElementById("mc-bonus-toggle").textContent = open ? "－ 唔計花紅" : "＋ 有花紅？計埋佢";
  // 收埋個 box 唔代表數字要丟——用戶可能撳漏手，淨係唔計入去。
  renderMortgage();
}

// 金額輸入格改用 type="text" 做千位逗號（type="number" 唔准入 ","，
// 瀏覽器會直接拒絕呢粒字）。讀值嗰陣要剝走逗號先 parse。
const _mcNum = (id) => { const v = parseFloat((document.getElementById(id)?.value || "").replace(/,/g, "")); return isFinite(v) ? v : 0; };
// 邊打邊插逗號。用「由頭數到 caret 果度有幾多個數字」嚟定位，重畫完之後
// 揾返第 N 個數字嘅位置放返 caret——純粹用字元 index 會因為逗號數量變咗
// 而錯位（打緊中間果段，後面新增/減少逗號會累加位移）。
function _mcFmtInput(el) {
  const digitsBefore = el.value.slice(0, el.selectionStart ?? el.value.length).replace(/[^\d]/g, "").length;
  const raw = el.value.replace(/[^\d.]/g, "");
  const dot = raw.indexOf(".");
  const intPart = dot === -1 ? raw : raw.slice(0, dot);
  const decPart = dot === -1 ? "" : raw.slice(dot);         // 含個 "."
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  el.value = grouped + decPart;
  let pos = 0, digits = 0;
  while (pos < el.value.length && digits < digitsBefore) {
    if (/\d/.test(el.value[pos])) digits++;
    pos++;
  }
  el.setSelectionRange(pos, pos);
  renderMortgage();
}
const _mcMoney = (n) => "$" + Math.round(n).toLocaleString();
// 大銀碼用「萬」睇得舒服啲（成個 app 都係咁講數）
const _mcWan = (n) => "$" + (n / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "萬";
const _mcRow = (label, value, opt = {}) => `
  <div style="display:flex;justify-content:space-between;gap:0.6rem;padding:0.3rem 0;${opt.top ? "border-top:1px solid var(--border);margin-top:0.3rem;padding-top:0.5rem" : ""}">
    <span style="color:var(--muted);font-size:0.8rem">${label}</span>
    <span style="font-weight:${opt.strong ? 700 : 600};font-size:${opt.strong ? "0.95rem" : "0.85rem"};color:${opt.color || "var(--text)"};white-space:nowrap">${value}</span>
  </div>`;

function renderMortgage() {
  const out = document.getElementById("mc-out");
  if (!out) return;
  const years = Math.min(30, Math.max(1, _mcNum("mc-years") || 30));
  const rate = _mcNum("mc-rate");
  const ftb = _mcFtb;
  const agentPct = _mcNum("mc-agent");
  const legalFee = _mcNum("mc-legal");
  const renoFee = _mcNum("mc-reno");

  if (_mcMode === "afford") {
    const baseIncome = _mcNum("mc-income");
    const cash = _mcNum("mc-cash") * 10000;
    // 花紅淨係喺個 box 開住（用戶主動撳咗「計埋佢」）先計入去——收埋咗
    // 就算入面留低咗數字都唔算，避免用戶漏手撳收埋之後仲當計咗。
    const bonusOpen = document.getElementById("mc-bonus-box").style.display !== "none";
    const bonusMonthly = bonusOpen
      ? bonusMonthlyIncome(baseIncome, _mcNum("mc-bonus-y1"), _mcNum("mc-bonus-y2")) : 0;
    const bonusPrev = document.getElementById("mc-bonus-preview");
    if (bonusPrev) bonusPrev.textContent = bonusMonthly > 0 ? `　依家計到月入加 ${_mcMoney(bonusMonthly)}。` : "";
    const income = baseIncome + bonusMonthly;
    if (!income || !cash) { out.innerHTML = `<div style="color:var(--muted);font-size:0.82rem">填咗月入同現金就即刻計俾你睇。</div>`; return; }
    const a = affordability({ income, cash, years, rate, firstTime: ftb, agentPct, legalFee, renoFee });
    if (!a) {
      out.innerHTML = `<div style="color:var(--down);font-size:0.82rem">依家呢個組合連 $50萬 嘅樓都上唔到會——試下加年期、減利率，或者儲多啲首期。</div>`;
      return;
    }
    const bindTxt = a.bind === "income"
      ? "夾住你嘅係<b>月入</b>（供款唔可以超過月入一半）——加年期或者等減息會鬆啲。"
      : a.bind === "ltv"
      ? "夾住你嘅係<b>按揭成數上限</b>（呢個樓價最多借到咁多）——首期再多都要夠人工先借得多。"
      : "夾住你嘅係<b>手頭現金</b>（首期＋印花稅＋雜費）——儲多啲現金就買得高啲。";
    // 出租盤：按揭保險淨係批自住（超 7 成一定要自住），所以如果打算收租，
    // 就算首期夠、人工夠，都封死喺金管局基本上限 70%——冧晒按保。用返
    // 同一份月入／現金計，睇下 70% 封頂之下買唔買得起同一層樓、定係要縮。
    const r = affordability({ income, cash, years, rate, firstTime: ftb, agentPct, legalFee, renoFee, maxLtv: HKMA_BASE_LTV });
    // 出租嗰行跟主數字同一級 font（1.5rem/700），但換第二種色（--accent2，
    // 呢個 app 用嚟做「連結／資訊」嗰隻藍）——同主色分得開，但唔會搶咗
    // 主數字嘅視覺重點。標籤自己一行，唔好同個大數字擠埋。
    const rentBlock = r
      ? `<div style="font-size:0.78rem;color:var(--muted)">如果打算出租（按揭保險淨批自住，封死 7 成）</div>
         <div style="font-size:1.5rem;font-weight:700;color:var(--accent2)">${_mcWan(r.price)}</div>
         <div style="font-size:0.75rem;color:var(--muted);margin-top:0.2rem">7 成貸款 ${_mcWan(r.loan)}，首期 ${_mcWan(r.down)}</div>`
      : `<div style="font-size:0.78rem;color:var(--muted)">如果打算出租（封 7 成）：依家個組合 7 成都上唔到會</div>`;
    // 用 --accent2 做底（跟返上面「$596萬」個數字同一隻色），唔用 ghost
    // 灰色——咁樣掣同數字連埋一齊睇，一眼就知邊個掣配邊個數。
    const rentBtn = r ? `<button class="vf-submit" style="flex:1;margin:0;background:var(--accent2);color:var(--on-accent2)" onclick="useMcAsBudget(${Math.round(r.price / 10000)})">
        用 ${_mcWan(r.price)} 做我嘅買盤預算（出租）
      </button>` : "";
    out.innerHTML = `
      <div style="background:var(--brand-soft);border:1px solid var(--brand);border-radius:var(--radius-sm);padding:0.7rem 0.85rem;margin-bottom:0.6rem">
        <div style="font-size:0.78rem;color:var(--muted)">你大約買得起</div>
        <div style="font-size:1.5rem;font-weight:700;color:var(--brand)">${_mcWan(a.price)}</div>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:0.2rem">${bindTxt}</div>
        <div style="border-top:1px solid var(--brand);opacity:0.35;margin:0.55rem 0"></div>
        ${rentBlock}
      </div>
      ${_mcRow("按揭成數", (a.ltv * 100).toFixed(0) + "%（貸款 " + _mcWan(a.loan) + "）")}
      ${_mcRow("每月供款", _mcMoney(a.monthly), { color: "var(--accent)" })}
      ${_mcRow("首期", _mcWan(a.down))}
      ${_mcRow("印花稅", _mcMoney(a.duty))}
      ${a.mip.amount ? _mcRow(`按揭保險（${a.mip.rate}%）`, _mcMoney(a.mip.amount)) : ""}
      ${_mcRow(`代理佣金（${agentPct}%）`, _mcMoney(a.agent))}
      ${_mcRow("律師費", _mcMoney(a.legal))}
      ${a.reno ? _mcRow("裝修費預留", _mcMoney(a.reno)) : ""}
      ${_mcRow("上會要準備嘅現金", _mcWan(a.cashNeeded), { strong: true, top: true })}
      <div style="display:flex;gap:0.5rem;margin-top:0.9rem">
        <button class="vf-submit" style="flex:1;margin:0" onclick="useMcAsBudget(${Math.round(a.price / 10000)})">
          ✓ 用 ${_mcWan(a.price)} 做我嘅買盤預算
        </button>
        ${rentBtn}
      </div>`;
    return;
  }

  const price = _mcNum("mc-price") * 10000;
  const ltv = Math.min(90, Math.max(1, _mcNum("mc-ltv") || 70)) / 100;
  if (!price) { out.innerHTML = `<div style="color:var(--muted);font-size:0.82rem">填咗樓價就即刻計俾你睇。</div>`; return; }
  const b = mortgageBreakdown({ price, ltv, years, rate, firstTime: ftb, agentPct, legalFee, renoFee });
  const notes = [];
  if (b.capped) notes.push(`借唔到 ${(ltv * 100).toFixed(0)}%——呢個樓價最多做到 <b>${(b.capLoan / price * 100).toFixed(0)}%</b>（${_mcWan(b.capLoan)}），已經幫你按上限計。`);
  if (b.mip.why) notes.push(b.mip.why);
  out.innerHTML = `
    <div style="background:var(--brand-soft);border:1px solid var(--brand);border-radius:var(--radius-sm);padding:0.7rem 0.85rem;margin-bottom:0.6rem">
      <div style="font-size:0.78rem;color:var(--muted)">每月供款</div>
      <div style="font-size:1.5rem;font-weight:700;color:var(--brand)">${_mcMoney(b.monthly)}</div>
      <div style="font-size:0.75rem;color:var(--muted);margin-top:0.2rem">月入要有 ${_mcMoney(b.incomeNeeded)} 以上先過到 50% 供款入息比率</div>
    </div>
    ${notes.map(n => `<div style="font-size:0.76rem;color:var(--accent);background:var(--badge-low-bg);border-radius:var(--radius-sm);padding:0.4rem 0.6rem;margin-bottom:0.5rem">⚠️ ${n}</div>`).join("")}
    ${_mcRow("貸款額", _mcWan(b.loan) + `（${(b.ltv * 100).toFixed(0)}%）`)}
    ${_mcRow("首期", _mcWan(b.down))}
    ${_mcRow("印花稅", _mcMoney(b.duty))}
    ${b.mip.amount ? _mcRow(`按揭保險（${b.mip.rate}%）`, _mcMoney(b.mip.amount)) : ""}
    ${_mcRow(`代理佣金（${agentPct}%）`, _mcMoney(b.agent))}
    ${_mcRow("律師費", _mcMoney(b.legal))}
    ${b.reno ? _mcRow("裝修費預留", _mcMoney(b.reno)) : ""}
    ${_mcRow("上會要準備嘅現金", _mcWan(b.cashNeeded), { strong: true, top: true })}`;
}

// ── 表單 markup ──────────────────────────────────────────────
// 純靜態字串（冇任何用戶輸入拼入去），所以直接 innerHTML 冇 XSS 問題。
const MC_FORM_HTML = `
<p style="font-size:0.8rem;color:var(--muted);margin:0.25rem 0 0.9rem">計埋首期、印花稅同按揭保險，睇下真係要準備幾多現金。</p>

<div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.2rem">
  <button type="button" class="filter-chip active" id="mc-tab-afford" onclick="setMcMode('afford')">我有幾多錢？</button>
  <button type="button" class="filter-chip" id="mc-tab-cost" onclick="setMcMode('cost')">睇中咗層樓</button>
</div>

<!-- ① 由入息倒推 -->
<div id="mc-pane-afford">
  <div class="vf-row2">
    <div><label class="vf-label">家庭月入（$）</label>
      <input class="vf-input" type="text" inputmode="decimal" id="mc-income" placeholder="例：60,000（唔連花紅）" oninput="_mcFmtInput(this)"></div>
    <div><label class="vf-label">手頭現金（萬）</label>
      <input class="vf-input" type="text" inputmode="decimal" id="mc-cash" placeholder="例：200" oninput="_mcFmtInput(this)"></div>
  </div>
  <!-- 花紅係月入嘅 sub-item：分開兩年輸入，因為銀行係計「兩年平均」
       唔係淨計去年，一年冇花紅（例如轉工）都仲計得到一個合理數。 -->
  <button type="button" onclick="toggleMcBonus()" id="mc-bonus-toggle"
    style="background:none;border:none;color:var(--accent2);font-size:0.78rem;padding:0.4rem 0 0;cursor:pointer;text-align:left">
    ＋ 有花紅？計埋佢
  </button>
  <div id="mc-bonus-box" style="display:none;margin-top:0.4rem">
    <label class="vf-label" style="margin-top:0">最近兩年每年花紅（$）</label>
    <div class="vf-row2" style="margin-top:0">
      <input class="vf-input" type="text" inputmode="decimal" id="mc-bonus-y1" placeholder="去年" oninput="_mcFmtInput(this)">
      <input class="vf-input" type="text" inputmode="decimal" id="mc-bonus-y2" placeholder="前年" oninput="_mcFmtInput(this)">
    </div>
    <p style="font-size:0.72rem;color:var(--muted);margin:0.35rem 0 0;line-height:1.45">
      銀行一般用「兩年平均 ÷ 12」計入月入，封頂喺底薪 3 倍——呢個唔係
      官方規定，各行做法唔一樣，呢度只做估算。<span id="mc-bonus-preview"></span>
    </p>
  </div>
</div>

<!-- ② 由樓價計 -->
<div id="mc-pane-cost" style="display:none">
  <div class="vf-row2">
    <div><label class="vf-label">樓價（萬）</label>
      <input class="vf-input" type="text" inputmode="decimal" id="mc-price" placeholder="例：800" oninput="_mcFmtInput(this)"></div>
    <div><label class="vf-label">按揭成數（%）</label>
      <input class="vf-input" type="number" id="mc-ltv" value="70" min="10" max="90" oninput="renderMortgage()"></div>
  </div>
</div>

<div class="vf-row2">
  <div><label class="vf-label">年期（年）</label>
    <input class="vf-input" type="number" id="mc-years" value="30" min="1" max="30" oninput="renderMortgage()"></div>
  <div><label class="vf-label">按揭利率（%）</label>
    <input class="vf-input" type="number" id="mc-rate" value="3.5" step="0.05" oninput="renderMortgage()"></div>
</div>

<div class="vf-row2">
  <div><label class="vf-label">代理佣金（%）</label>
    <input class="vf-input" type="number" id="mc-agent" value="1" step="0.1" oninput="renderMortgage()"></div>
  <div><label class="vf-label">律師費（$）</label>
    <input class="vf-input" type="text" inputmode="decimal" id="mc-legal" value="15,000" oninput="_mcFmtInput(this)"></div>
</div>

<!-- 裝修費預留：淨係擺喺呢度俾用戶主動填，唔畀 placeholder 建議數字
     （唔似代理佣金／律師費咁有業內慣例，各人裝修預算差好遠，估錯
     誤導人)。留空＝當 0，唔會扣手頭現金。 -->
<label class="vf-label">裝修費預留（$）</label>
<input class="vf-input" type="text" inputmode="decimal" id="mc-reno" placeholder="未打算裝修可留空" oninput="_mcFmtInput(this)">

<label class="vf-label">係咪首次置業？</label>
<div id="mc-ftb" style="display:flex;gap:0.4rem;flex-wrap:wrap">
  <button type="button" class="filter-chip active" data-ftb="1" onclick="setMcFtb(this)">係（名下冇香港住宅）</button>
  <button type="button" class="filter-chip" data-ftb="0" onclick="setMcFtb(this)">唔係</button>
</div>

<div id="mc-out" style="margin-top:1rem"></div>

<p style="font-size:0.72rem;color:var(--muted);margin:1rem 0 0;line-height:1.5">
  印花稅按稅務局 2026-02-26 起嘅稅階計；按揭成數同保費按按證保險現行規定
  （保費表 2024 年 10 月版，取「浮息＋一次過付清」）。SSD／BSD／NRSD 已經
  喺 2024-02-28 撤銷，壓力測試亦喺 2025-02-28 取消，所以呢度唔會再計。
  律師費同代理佣金冇官方公價，上面兩格可以改成你收到嘅報價。花紅計法
  （兩年平均封頂底薪 3 倍）同「出租封 7 成」都係市場慣例，唔係監管
  規定，各行做法唔一樣。實際批核以銀行為準。
</p>
`;
function mountMortgageForm(hostId = "mc-form-host") {
  const host = document.getElementById(hostId);
  if (!host || host.dataset.mounted) return;
  host.innerHTML = MC_FORM_HTML;
  host.dataset.mounted = "1";
}
