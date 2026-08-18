let lastResult = null;

function parseTransactions(raw){
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const records = [];

  for (let i = 0; i < lines.length; i++){
    if (lines[i].toLowerCase() === 'credit'){
      const idAmountLine = lines[i-2];
      const typeLine = lines[i-1];
      const dateLine = lines[i+2];
      const timeLine = lines[i+3];
      if (!idAmountLine || !typeLine) continue;

      const idMatch = idAmountLine.match(/(\d{4,})/);
      const amtMatch = idAmountLine.match(/(-?\$[\d,]+(?:\.\d+)?)/);
      if (!idMatch || !amtMatch) continue;

      const id = idMatch[1];
      const amount = parseFloat(amtMatch[1].replace(/[$,]/g, ''));
      const type = typeLine.trim();

      let dateObj = null;
      let time = timeLine || '';
      if (dateLine && timeLine){
        const cleanTime = timeLine.replace(/\s+[A-Z]{2,4}$/, ''); // strip trailing timezone abbrev
        const parsed = new Date(`${dateLine} ${cleanTime}`);
        if (!isNaN(parsed.getTime())){
          dateObj = parsed;
          time = `${dateLine}, ${timeLine}`;
        }
      }

      records.push({ id, amount, type, time, dateObj, order: i });
    }
  }
  return records;
}

function classify(type){
  const t = type.toLowerCase();
  const isDeposit = t.includes('deposit') && !t.includes('withdrawal');
  const isLineupPlaced = t.includes('lineup') && t.includes('placed');
  const isMarketBuy = t.includes('buy');
  const isLineupRefund = t.includes('lineup') && (t.includes('refund') || t.includes('void') || t.includes('cancel'));
  const isWithdrawalRefund = t.includes('withdrawal') && t.includes('refund');
  const isWithdrawal = t.includes('withdrawal') && !t.includes('refund');
  return { isDeposit, isLineupPlaced, isMarketBuy, isLineupRefund, isWithdrawal, isWithdrawalRefund };
}

function calculate(){
  const raw = document.getElementById('txInput').value;

  if (!raw.trim()){
    alert('Paste your transaction history first.');
    return;
  }

  const records = parseTransactions(raw);
  if (records.length === 0){
    alert("Couldn't read any transactions from that paste. Make sure you copied the full rows including the \"Credit\" line.");
    return;
  }

  const deposits = [];
  const counted = [];
  const refunds = [];
  const withdrawals = [];
  const excluded = [];
  const classified = [];

  records.forEach(r => {
    const c = classify(r.type);
    let kind = 'excluded';
    let tag = null;
    if (c.isDeposit){ kind = 'deposit'; }
    else if (c.isLineupPlaced){ kind = 'play'; tag = 'Lineup Placed'; }
    else if (c.isMarketBuy){ kind = 'play'; tag = 'Predict Market Buy'; }
    else if (c.isLineupRefund){ kind = 'lineupRefund'; }
    else if (c.isWithdrawal){ kind = 'withdrawal'; }
    else if (c.isWithdrawalRefund){ kind = 'withdrawalRefund'; }
    const rec = Object.assign({}, r, { kind, tag });
    classified.push(rec);
    if (kind === 'deposit') deposits.push(rec);
    else if (kind === 'play') counted.push(rec);
    else if (kind === 'lineupRefund') refunds.push(rec);
    else if (kind === 'withdrawal') withdrawals.push(rec);
    else if (kind === 'excluded' || kind === 'withdrawalRefund') excluded.push(rec);
  });

  if (deposits.length === 0){
    alert("No deposit transactions were found in this paste, so there's nothing to set a playthrough requirement against.");
    return;
  }

  // Put everything in chronological (oldest-first) order so play activity and
  // withdrawals can be applied against deposits in the order they actually
  // happened. Prefer real parsed timestamps; where those aren't available,
  // fall back to the pasted order (transaction history exports newest-first,
  // so a higher `order` index means older).
  const chronological = classified.slice().sort((a, b) => {
    if (a.dateObj && b.dateObj) return a.dateObj - b.dateObj;
    return b.order - a.order;
  });

  // Independent per-deposit tracking (used for the Deposits table below):
  // play activity only ever credits whichever deposit was most recently
  // made at the time it happened. Once a new deposit comes in, later play
  // credits that new deposit — any leftover/remaining requirement on an
  // older deposit is NOT carried forward or backfilled by later play.
  // Each deposit stands on its own, purely for transparency into each
  // deposit's individual status.
  //
  // A lineup refund reverses the credit that lineup earned — the member
  // needs to play that amount through again, so it's subtracted back out
  // of whichever deposit was current at the time.
  //
  // Withdrawals are matched against later Withdrawal Refunds (same amount)
  // to tell a "successful" withdrawal (money actually left, never reversed)
  // apart from an attempted one that bounced back.
  const allDeposits = [];
  const flaggedWithdrawals = [];
  const openWithdrawals = [];
  let currentDeposit = null;

  chronological.forEach(r => {
    if (r.kind === 'deposit'){
      const dep = { ref: r, amount: Math.abs(r.amount), played: 0 };
      allDeposits.push(dep);
      currentDeposit = dep;
    } else if (r.kind === 'play'){
      if (currentDeposit){
        currentDeposit.played += Math.abs(r.amount);
      }
      // play activity before any deposit has ever been made has nothing to credit.
    } else if (r.kind === 'lineupRefund'){
      if (currentDeposit){
        currentDeposit.played = Math.max(0, currentDeposit.played - Math.abs(r.amount));
      }
    } else if (r.kind === 'withdrawal'){
      const outstanding = allDeposits.reduce((sum, d) => sum + Math.max(0, d.amount - d.played), 0);
      if (outstanding > 0.005){
        flaggedWithdrawals.push({ ref: r, outstanding });
      }
      openWithdrawals.push(r);
    } else if (r.kind === 'withdrawalRefund'){
      const amt = Math.abs(r.amount);
      const matchIdx = openWithdrawals.findIndex(w => Math.abs(w.amount) === amt);
      if (matchIdx !== -1) openWithdrawals.splice(matchIdx, 1);
    }
  });

  // Anything left in openWithdrawals was never matched to a refund — it
  // actually went through successfully.
  const successfulWithdrawals = new Set(openWithdrawals);
  const successfulWithdrawalExists = openWithdrawals.length > 0;

  allDeposits.forEach(d => {
    d.playedCapped = Math.min(d.played, d.amount);
    d.remaining = Math.max(0, d.amount - d.played);
    d.cleared = d.remaining <= 0.005;
  });

  // Progress panel: deposits STACK into one running requirement (each new
  // deposit adds its amount on top of whatever's still owed), and play
  // activity stacks the same way against that running total — reversed
  // (refunded) withdrawals have no effect at all. But the moment a
  // withdrawal actually goes through successfully, the amount played so
  // far resets to zero, and whatever was still outstanding at that moment
  // gets reduced by the withdrawal amount — that leftover then carries
  // forward and stacks with the next deposit.
  let stackRequirement = 0;
  let stackPlayed = 0;

  chronological.forEach(r => {
    if (r.kind === 'deposit'){
      stackRequirement += Math.abs(r.amount);
    } else if (r.kind === 'play'){
      stackPlayed += Math.abs(r.amount);
    } else if (r.kind === 'lineupRefund'){
      stackPlayed = Math.max(0, stackPlayed - Math.abs(r.amount));
    } else if (r.kind === 'withdrawal'){
      if (successfulWithdrawals.has(r)){
        const remainingNow = Math.max(0, stackRequirement - stackPlayed);
        stackRequirement = Math.max(0, remainingNow - Math.abs(r.amount));
        stackPlayed = 0;
      }
      // a withdrawal that later gets reversed (refunded) never touches the stack.
    }
  });

  const requirement = stackRequirement;
  const remaining = Math.max(0, requirement - stackPlayed);
  const played = Math.max(0, requirement - remaining);
  const cleared = remaining <= 0.005;
  const pct = requirement > 0 ? Math.min(100, (played / requirement) * 100) : 100;

  lastResult = { requirement, played, remaining, cleared, flaggedWithdrawals, successfulWithdrawalExists };

  // Ring
  const circumference = 339.29;
  const offset = circumference - (pct / 100) * circumference;
  const ringFg = document.getElementById('ringFg');
  ringFg.style.strokeDashoffset = offset;
  ringFg.style.stroke = cleared ? 'var(--good)' : 'var(--accent)';
  document.getElementById('ringPct').textContent = Math.round(pct) + '%';

  const statusLine = document.getElementById('statusLine');
  const statusDetail = document.getElementById('statusDetail');
  if (cleared){
    statusLine.className = 'status cleared';
    statusLine.textContent = '✓ Playthrough cleared';
    statusDetail.innerHTML = `Played through <b>$${played.toFixed(2)}</b> of the required <b>$${requirement.toFixed(2)}</b> currently owed. Eligible for withdrawal (subject to any active 72-hour hold).`;
  } else {
    statusLine.className = 'status pending';
    statusLine.textContent = 'Playthrough in progress';
    statusDetail.innerHTML = `Still needs <b>$${remaining.toFixed(2)}</b> more in play before those funds clear for withdrawal. Deposits stack onto this total, and a successful withdrawal resets progress and carries forward whatever was still owed.`;
  }

  document.getElementById('statReq').textContent = '$' + requirement.toFixed(2);
  document.getElementById('statPlayed').textContent = '$' + played.toFixed(2);
  const remEl = document.getElementById('statRemaining');
  remEl.textContent = '$' + remaining.toFixed(2);
  remEl.className = 'v ' + (cleared ? 'good' : 'amber');

  // Withdrawal warning banner — this stays based on ALL deposits (not just
  // the latest), since it's flagging a compliance issue: a withdrawal that
  // went out while some deposit, anywhere in the history, still owed play.
  const warnEl = document.getElementById('withdrawalWarning');
  if (flaggedWithdrawals.length > 0){
    warnEl.style.display = 'block';
    warnEl.innerHTML = `⚠ <b>${flaggedWithdrawals.length} withdrawal(s)</b> occurred while a deposit still had an outstanding playthrough requirement — see the table below.`;
  } else {
    warnEl.style.display = 'none';
    warnEl.innerHTML = '';
  }

  // Deposit table — newest first, each row shows its own played/remaining/status.
  const depositBody = document.querySelector('#depositTable tbody');
  const displayDeposits = allDeposits.slice().reverse();
  depositBody.innerHTML = displayDeposits.length ? displayDeposits.map(d => {
    const isCleared = d.remaining <= 0.005;
    return `
    <tr>
      <td class="id">${d.ref.id}</td>
      <td class="amt pos">+$${d.amount.toFixed(2)}</td>
      <td class="amt accent">$${d.playedCapped.toFixed(2)}</td>
      <td class="amt ${isCleared ? '' : 'neg'}">$${d.remaining.toFixed(2)}</td>
      <td>${isCleared ? '<span class="tag" style="background:var(--good-soft); color:var(--good);">Cleared</span>' : '<span class="tag" style="background:var(--bad-soft); color:var(--bad);">Pending</span>'}</td>
      <td class="time">${d.ref.time}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" style="color:var(--muted-2); padding:14px 6px;">No deposit entries found.</td></tr>`;
  document.getElementById('depositCount').textContent = allDeposits.length;

  // Flagged withdrawals table
  const flaggedBody = document.querySelector('#flaggedTable tbody');
  const displayFlagged = flaggedWithdrawals.slice().reverse();
  flaggedBody.innerHTML = displayFlagged.length ? displayFlagged.map(f => `
    <tr>
      <td class="id">${f.ref.id}</td>
      <td class="amt neg">-$${Math.abs(f.ref.amount).toFixed(2)}</td>
      <td class="amt neg">$${f.outstanding.toFixed(2)}</td>
      <td class="time">${f.ref.time}</td>
    </tr>`).join('') : `<tr><td colspan="4" style="color:var(--muted-2); padding:14px 6px;">No withdrawals before playthrough completed.</td></tr>`;
  document.getElementById('flaggedCount').textContent = flaggedWithdrawals.length;

  // Counted table
  const countedBody = document.querySelector('#countedTable tbody');
  countedBody.innerHTML = counted.length ? counted.map(r => `
    <tr>
      <td class="id">${r.id}</td>
      <td><span class="tag">${r.tag}</span></td>
      <td class="amt neg">-$${Math.abs(r.amount).toFixed(2)}</td>
      <td class="time">${r.time}</td>
    </tr>`).join('') : `<tr><td colspan="4" style="color:var(--muted-2); padding:14px 6px;">No lineup or market buy entries found.</td></tr>`;
  document.getElementById('countedCount').textContent = counted.length;

  // Refund table
  const refundBody = document.querySelector('#refundTable tbody');
  refundBody.innerHTML = refunds.length ? refunds.map(r => `
    <tr>
      <td class="id">${r.id}</td>
      <td class="amt pos">+$${Math.abs(r.amount).toFixed(2)}</td>
      <td class="time">${r.time}</td>
    </tr>`).join('') : `<tr><td colspan="3" style="color:var(--muted-2); padding:14px 6px;">No refunded lineups found.</td></tr>`;
  document.getElementById('refundCount').textContent = refunds.length;

  // Excluded table
  const excludedBody = document.querySelector('#excludedTable tbody');
  excludedBody.innerHTML = excluded.length ? excluded.map(r => `
    <tr>
      <td class="id">${r.id}</td>
      <td>${r.type}</td>
      <td class="amt ${r.amount < 0 ? 'neg' : 'pos'}">${r.amount < 0 ? '-' : '+'}$${Math.abs(r.amount).toFixed(2)}</td>
    </tr>`).join('') : `<tr><td colspan="3" style="color:var(--muted-2); padding:14px 6px;">Nothing excluded.</td></tr>`;
  document.getElementById('excludedCount').textContent = excluded.length;

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('resultsBody').style.display = 'block';
  document.getElementById('spielPanel').style.display = cleared ? 'none' : 'block';

  renderSpiel();
}

function renderSpiel(){
  const box = document.getElementById('spielBox');
  if (!lastResult){
    box.className = 'spiel-box empty';
    box.textContent = "Calculate a member's transactions above to generate a spiel.";
    return;
  }

  const name = document.getElementById('memberName').value.trim() || 'there';
  const req = lastResult.requirement.toFixed(2);
  const played = lastResult.played.toFixed(2);
  const remaining = lastResult.remaining.toFixed(2);

  const text = `Hi ${name}, thanks for reaching out about your withdrawal. Every deposit requires a 1x playthrough before those funds become eligible to withdraw — right now that's $${req} still required.

You've played through $${played} so far, so there's $${remaining} left to go. Playthrough counts each time you place a lineup or make a Predict Market buy — if a lineup is later refunded, that amount goes back to needing to be played through again, so a win doesn't need replaying but a refund does. Once you hit $${req} in play, the funds will be cleared for withdrawal (also subject to the standard 72-hour hold if this was funded by bank transfer). Let me know if you have any questions!`;

  box.className = 'spiel-box';
  box.textContent = text;
  document.getElementById('copyBtn').classList.remove('copied');
  document.getElementById('copyBtn').textContent = 'Copy to clipboard';
}

function copySpiel(){
  const box = document.getElementById('spielBox');
  if (!lastResult) return;
  navigator.clipboard.writeText(box.textContent).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.classList.add('copied');
    btn.textContent = 'Copied ✓';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = 'Copy to clipboard';
    }, 1800);
  });
}

function clearAll(){
  document.getElementById('txInput').value = '';
  document.getElementById('memberName').value = '';
  document.getElementById('emptyState').style.display = 'block';
  document.getElementById('resultsBody').style.display = 'none';
  document.getElementById('spielPanel').style.display = 'none';
  lastResult = null;
  renderSpiel();
}
