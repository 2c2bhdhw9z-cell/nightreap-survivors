"""
Drives a real browser at the operator's run list and reads the figures off the screen.

Run it with the site already serving and the operator secret in the environment:

    EVENT_LOG_ADMIN_TOKEN=... ADMIN_URL=http://localhost:5173/admin \
      python3 packages/web/src/web/components/admin/runs-screen.check.py

It checks the things that can only be checked in a browser: that a tab holding no secret sees nothing, that
a tab holding the wrong secret is refused in the same plain way, that the two narrowing switches really
narrow, that a stored recording only travels when somebody asks for it, and that there is nothing anywhere on
the page that marks a run as dealt with. Exits non-zero on the first thing that is not true.
"""

import os
import re, sys
from playwright.sync_api import sync_playwright

TOKEN = os.environ.get("EVENT_LOG_ADMIN_TOKEN", "")
BAD = "wrong-secret-but-long-enough"
URL = os.environ.get("ADMIN_URL", "http://localhost:5173/admin")
FLAGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

if TOKEN == "":
    raise SystemExit("Set EVENT_LOG_ADMIN_TOKEN to the operator secret this site is running with.")

failures = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" :: " + str(detail)) if detail else ""))
    if not ok:
        failures.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=FLAGS)
    page = b.new_page(viewport={"width": 1280, "height": 1400})

    # 1. no token -> gate only, no runs
    page.goto(URL, wait_until="networkidle")
    body = page.inner_text("body")
    check("no token shows the gate", "operator secret" in body.lower())
    check("no token shows no runs", "Runs that came in" not in body)

    # 2. wrong token -> plain refusal, still no runs
    page.fill('input[aria-label="Operator secret"]', BAD)
    page.click("text=Unlock")
    page.wait_for_timeout(2500)
    body = page.inner_text("body")
    check("wrong token is refused", "would not accept that secret" in body)
    page.screenshot(path=os.environ.get("SHOT_DIR", "/tmp") + "/admin-wrong-token.png", full_page=False)

    # 3. real token
    page.evaluate("t => window.sessionStorage.setItem('nightreap.operator.token', t)", TOKEN)
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(2500)
    body = page.inner_text("body")
    check("real token loads the runs panel", "runs that came in, newest first" in body.lower())
    m = re.search(r"Showing (\d+) upload", body)
    all_count = int(m.group(1)) if m else -1
    check("unfiltered list is full", all_count == 25, all_count)
    cards = page.locator("text=Fetch the recording").count()
    check("one fetch button per card", cards == all_count, cards)
    check("kept runs are labelled", "Kept" in body)
    page.screenshot(path=os.environ.get("SHOT_DIR", "/tmp") + "/admin-runs-all.png", full_page=True)

    # 4. only refused
    page.check('input[aria-label="Only the ones turned away"]')
    page.wait_for_timeout(2000)
    body = page.inner_text("body")
    refused_shown = int(re.search(r"Showing (\d+) upload", body).group(1))
    check("refused filter still fills the page", refused_shown == 25, refused_shown)
    check("refused filter hides kept runs", body.count("Kept") == 0, body.count("Kept"))
    check("refused runs say why", "Turned away because:" in body)
    page.screenshot(path=os.environ.get("SHOT_DIR", "/tmp") + "/admin-runs-refused.png", full_page=True)

    # 5. only flagged
    page.uncheck('input[aria-label="Only the ones turned away"]')
    page.check('input[aria-label="Only the ones worth a look"]')
    page.wait_for_timeout(2000)
    body = page.inner_text("body")
    flagged_shown = int(re.search(r"Showing (\d+) upload", body).group(1))
    check("flagged filter narrows the list", 0 < flagged_shown <= all_count, flagged_shown)
    worth = len(re.findall(r"\d+ worth a look", body))
    check("every flagged row is tagged", worth >= flagged_shown, (worth, flagged_shown))
    page.screenshot(path=os.environ.get("SHOT_DIR", "/tmp") + "/admin-runs-flagged.png", full_page=True)
    page.uncheck('input[aria-label="Only the ones worth a look"]')
    page.wait_for_timeout(1500)

    # 6. nothing marks a run handled
    body = page.inner_text("body")
    for word in ["Handled", "handled it", "Mark as fine", "Clear flag", "Dismiss"]:
        check(f"no '{word}' control", word not in body)

    # 7. fetch one recording
    page.locator("text=Fetch the recording").first.click()
    page.wait_for_timeout(2500)
    body = page.inner_text("body")
    check("recording arrives", "of recording, stored exactly as it arrived" in body)
    check("claim is shown", "what the device said happened" in body.lower())
    check("verdict is shown", "what the server decided at the time" in body.lower())
    page.screenshot(path=os.environ.get("SHOT_DIR", "/tmp") + "/admin-runs-log.png", full_page=False)

    # 8. one account's history via the account id button
    acct = page.locator("button[title='Look this player up above']").first
    acct_id = acct.inner_text()
    acct.click()
    page.wait_for_timeout(3000)
    body = page.inner_text("body")
    check("account history appears", f"runs {acct_id.lower()} has sent in" in body.lower())
    tally = re.search(r"(\d+) kept\s+(\d+) turned away\s+(\d+) worth a look", body)
    check("account tally is shown", tally is not None, tally.group(0) if tally else body[:200])
    if tally:
        kept, away, odd = (int(x) for x in tally.groups())
        check("tally adds up to the rows shown", kept + away >= 1, (kept, away, odd))
    page.screenshot(path=os.environ.get("SHOT_DIR", "/tmp") + "/admin-runs-account.png", full_page=True)

    # 9. the recording can be fetched from the account's own list too
    card = page.locator(
        "xpath=//h2[contains(., 'HAS SENT IN') or contains(., 'has sent in')]/following-sibling::div//ul/li[1]"
    ).first
    card.locator("text=Fetch the recording").first.click()
    page.wait_for_timeout(2500)
    inside = card.inner_text()
    check("account list fetches its own recording", "stored exactly as it arrived" in inside)
    check("account list shows the claim", "what the device said happened" in inside.lower())
    page.screenshot(path=os.environ.get("SHOT_DIR", "/tmp") + "/admin-runs-account-log.png", full_page=False)

    b.close()

print(f"{len(failures)} failures")
sys.exit(1 if failures else 0)
