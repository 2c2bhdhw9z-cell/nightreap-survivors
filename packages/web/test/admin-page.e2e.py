"""
The break-glass page, driven in a real browser against a real server.

WHY THIS EXISTS AS A BROWSER TEST AND NOT AS A UNIT TEST
The page's promises are promises about what an operator sees and can press: that the standing shown was
worked out from the rows, that a punishment cannot be filed without a reason, that lifting one leaves it on
the record greyed out rather than making it disappear, and that a lifted punishment can be put back. None of
those can be checked by calling a function; they are only true if the screen actually behaves that way.

The server it drives is the built app served by its own entry point, pointed at a throwaway file database
made a moment ago. Nothing here can touch live data: the seed script refuses to run against anything that is
not a local file, and the database is deleted at the end.

Run: python3 packages/web/test/admin-page.e2e.py
Exits non-zero on the first broken promise.
"""

import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

WEB = pathlib.Path(__file__).resolve().parent.parent
DB = "/tmp/nightreap-admin-e2e.db"
PORT = 4218
TOKEN = "an-operator-secret-long-enough"
SUBJECT = "acct-e2e"
BASE = f"http://127.0.0.1:{PORT}"

ENV = {
    **os.environ,
    "DATABASE_URL": f"file:{DB}",
    "DATABASE_AUTH_TOKEN": "x",
    "EVENT_LOG_ADMIN_TOKEN": TOKEN,
    "PORT": str(PORT),
    "SEED_SUBJECT": SUBJECT,
}

failures = 0
checks = 0


def check(what, ok, detail=""):
    global failures, checks
    checks += 1
    if not ok:
        failures += 1
        print(f"FAIL {what}" + (f" — {detail}" if detail else ""))


def run(cmd):
    done = subprocess.run(cmd, cwd=WEB, env=ENV, capture_output=True, text=True)
    if done.returncode != 0:
        print(f"setup failed: {' '.join(cmd)}\n{done.stdout}\n{done.stderr}")
        sys.exit(2)
    return done.stdout


def wait_for_server():
    for _ in range(120):
        try:
            urllib.request.urlopen(f"{BASE}/api/health", timeout=1)
            return True
        except Exception:
            time.sleep(0.5)
    return False


def main():
    global failures

    if os.path.exists(DB):
        os.remove(DB)

    print("-- building a throwaway record")
    run(["bunx", "drizzle-kit", "push", "--force"])
    run(["bun", "test/seed.ts"])
    run(["bun", "run", "build"])

    server = subprocess.Popen(
        ["bun", "src/__server.ts"], cwd=WEB, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    try:
        if not wait_for_server():
            print("setup failed: the server never came up")
            sys.exit(2)

        with sync_playwright() as play:
            browser = play.chromium.launch(
                executable_path="/usr/bin/google-chrome",
                args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"],
            )
            page = browser.new_page()
            page.goto(f"{BASE}/admin", wait_until="networkidle")

            print("-- the door")
            check("the page asks for the operator secret", page.get_by_label("Operator secret").is_visible())
            check("no player history is on screen before unlocking", "Everything on record" not in page.content())

            page.get_by_label("Operator secret").fill("too-short")
            check("a secret too short to be real cannot be submitted", page.get_by_role("button", name="Unlock").is_disabled())

            page.get_by_label("Operator secret").fill("a" * len(TOKEN))
            page.get_by_role("button", name="Unlock").click()
            page.wait_for_timeout(1500)
            check("the wrong secret is turned away", "would not accept that secret" in page.content(), page.content()[:200])

            print("-- unlocking properly")
            page.get_by_role("button", name="Lock this page").click()
            page.get_by_label("Operator secret").fill(TOKEN)
            page.get_by_role("button", name="Unlock").click()
            page.wait_for_selector("text=What can be done", timeout=15000)
            check("the buttons arrive from the server", page.get_by_role("button", name="Mute chat").is_visible())
            check("the server reports no disagreement about its buttons", "disagrees with the record" not in page.content())
            check("a one-way action is marked as one", "Clear everything chat-related ↯" in page.content())

            print("-- looking a player up")
            page.get_by_label("Player id").fill(SUBJECT)
            page.get_by_role("button", name="Look up").click()
            page.wait_for_selector(f"text=Where {SUBJECT} stands", timeout=15000)
            body = page.content()
            check("the gold was added up from the rows", "1,234" in body, "the seeded grant was 1234")
            check("the ban is showing", "Chat banned" in body and "Chat banned — no" not in body)
            check("the history is on screen", "Chat banned" in body and "Gold given" in body)
            check("the seeded lines name who filed them", "seed-operator" in body)

            print("-- nothing can be filed without a reason")
            page.get_by_role("button", name="Mute chat").click()
            check("a mute cannot be filed with nothing filled in", page.get_by_role("button", name="File it").is_disabled())

            page.get_by_label("Why").fill("chat abuse reported by two other players")
            check("a reason on its own is not enough — nobody has said who they are", page.get_by_role("button", name="File it").is_disabled())
            page.get_by_label("Your own name").fill("brett")
            check("still not enough, because the mute length is missing", page.get_by_role("button", name="File it").is_disabled())

            # Everything else is now filled in, so from here the reason is the only thing standing in the
            # way. Checking the reason while something else is also missing would prove nothing at all.
            page.get_by_label("Hours").select_option(index=1)
            check("with everything filled in, it can be filed", page.get_by_role("button", name="File it").is_enabled())

            page.get_by_label("Why").fill("bad")
            check("a reason of three letters is refused", page.get_by_role("button", name="File it").is_disabled(), "and nothing else is missing at this point")
            check("and the page says why", "at least eight characters" in page.content())
            page.get_by_label("Why").fill("aaaaaaaaaa")
            check("one letter held down is not a reason", page.get_by_role("button", name="File it").is_disabled())
            check("and the page says so plainly", "That is not a reason" in page.content())
            page.get_by_label("Why").fill("x" * 513)
            check("a reason longer than the record allows is refused", page.get_by_role("button", name="File it").is_disabled())

            print("-- filing a mute")
            page.get_by_label("Why").fill("chat abuse reported by two other players")
            check("a proper reason lets it through", page.get_by_role("button", name="File it").is_enabled())
            page.get_by_role("button", name="File it").click()
            page.wait_for_selector("text=Filed as line", timeout=15000)
            page.wait_for_timeout(800)
            body = page.content()
            check("the mute is on the record", "Muted" in body)
            check("the standing says they are muted", body.count("Muted") >= 2, "one on the record, one in the standing")
            check("the reason box was emptied afterwards", page.get_by_label("Why").input_value() == "", "the next action must not inherit this excuse")

            print("-- lifting the newest punishment")
            # The newest line is the mute just filed, so this lifts the mute and must leave the older ban
            # exactly where it was. A lift that quietly reached further than the line it named would be the
            # worst possible bug on this page.
            page.get_by_label("Why").fill("the appeal was upheld this morning")
            page.get_by_role("button", name="Undo this").first.click()
            page.wait_for_selector("text=Undone. That is line", timeout=15000)
            page.wait_for_timeout(1000)
            body = page.content()
            check("the lifted line is still on the record", "Lifted by #" in body, "a punishment must never simply disappear")
            check("the lift is on the record too", "undid #" in body)
            check("the mute is lifted", "Muted — no" in body, "the standing is worked out again from the rows")
            check("the older ban is untouched", "Chat banned — no" not in body, "a lift must only reach the line it names")

            print("-- putting it back")
            page.get_by_label("Why").fill("the appeal turned out to be a lie")
            page.get_by_role("button", name="Put it back").first.click()
            page.wait_for_selector("text=Put back. That is line", timeout=15000)
            page.wait_for_timeout(1000)
            body = page.content()
            check("the mute is back in force", "Muted — no" not in body)
            check("and the record says it was put back", "put back what #" in body)

            print("-- the history of one line reads out in order")
            page.get_by_role("button", name="History").first.click()
            page.wait_for_selector("text=Hide history", timeout=15000)
            page.wait_for_timeout(2000)
            story = page.locator("ol").first.inner_text() if page.locator("ol").count() > 0 else ""
            check("the story is on screen", "by" in story and len(story) > 0, repr(story[:300]))
            check("the story does not report a failure", "Could not read" not in page.content())

            print("-- an action that is about nobody in particular")
            # Holding a build back is about the build, not about a player. Filed against one player it would
            # read forever as that player having been punished, so the page refuses it while an account is
            # open rather than quietly dropping the name.
            page.get_by_role("button", name="Quarantine a build").click()
            page.get_by_label("Build").fill("1000")
            check("it refuses to be filed against the open account", page.get_by_role("button", name="File it").is_disabled())
            check("and says why in words", "not about a player" in page.content(), "a build held back must never read as one player being punished")

            # Letting a build through is the one-way half of that pair: to stop it again you quarantine it
            # again. The operator has to be told that before pressing it, not after.
            page.get_by_role("button", name="Release a build").click()
            check("a one-way action carries its warning", "This cannot be undone" in page.content())
            check("and its button says so", page.get_by_role("button", name="File it — one way").is_visible())

            print("-- inputs do not carry over between actions")
            page.get_by_role("button", name="Give gold back").click()
            page.get_by_label("Amount").fill("50")
            page.get_by_role("button", name="Give Reaper Marks back").click()
            check("an amount typed for one action does not follow into the next", page.get_by_label("Amount").input_value() == "", "an amount meant for gold must never be filed as marks")

            print("-- the standing is worked out again after every change")
            page.get_by_role("button", name="Give gold back").click()
            page.get_by_label("Amount").fill("50")
            page.get_by_label("Why").fill("lost to a crash on the boss wave")
            page.get_by_role("button", name="File it").click()
            page.wait_for_selector("text=Filed as line", timeout=15000)
            page.wait_for_timeout(1000)
            check("the gold went up by exactly what was given", "1,284" in page.content(), "1234 seeded plus 50 given")

            print("-- a note is not something that can be undone")
            page.get_by_role("button", name="Write a note").click()
            page.get_by_label("Why").fill("spoke to them about the chat and they understood")
            page.get_by_role("button", name="File it — one way").click()
            page.wait_for_selector("text=Filed as line", timeout=15000)
            page.wait_for_timeout(1000)
            newest = page.locator("ul > li").first
            check("the note is the newest thing on the record", "Note" in newest.inner_text(), newest.inner_text()[:120])
            check("and it cannot be undone", "Undo this" not in newest.inner_text(), "whether a line can be lifted is the server's answer, not the screen's")
            check("but its history can still be read", "History" in newest.inner_text())

            print("-- an account nobody has touched")
            page.get_by_label("Player id").fill("acct-nobody-at-all")
            page.get_by_role("button", name="Look up").click()
            page.wait_for_selector("text=Where acct-nobody-at-all stands", timeout=15000)
            page.wait_for_timeout(600)
            body = page.content()
            check("an unknown account reads back empty rather than erroring", "Nothing on record for this account" in body)
            check("and is in good standing", body.count("— no") >= 4, "muted, banned, flagged and segregated should all read no")

            print("-- the record reads newest first")
            page.get_by_label("Player id").fill(SUBJECT)
            page.get_by_role("button", name="Look up").click()
            page.wait_for_selector(f"text=Where {SUBJECT} stands", timeout=15000)
            page.wait_for_timeout(800)
            lines = page.locator("ul > li").all_inner_texts()
            numbered = [int(re.search(r"#(\d+)", text).group(1)) for text in lines if re.search(r"#(\d+)", text)]
            check("every line on screen is numbered", len(numbered) == len(lines), f"{len(numbered)} of {len(lines)}")
            check("the newest is at the top", numbered == sorted(numbered, reverse=True), str(numbered))
            check("there is more than one line, so that check means something", len(numbered) > 3, str(len(numbered)))

            print("-- a lifted line is dimmed rather than removed")
            dimmed = page.locator("ul > li.opacity-50")
            check("the lifted line is still drawn, only dimmed", dimmed.count() >= 1, f"{dimmed.count()} dimmed lines")
            check("and it is struck through", page.locator("ul > li .line-through").count() >= 1)
            check("and it offers no second lift", "Undo this" not in dimmed.first.inner_text(), "one punishment, one lift")

            print("-- an undo needs a reason too")
            page.get_by_label("Why").fill("")
            page.get_by_role("button", name="Undo this").first.click()
            page.wait_for_timeout(1500)
            complaint = page.locator("p.border-red-900")
            check("the server turns down an undo with no reason", complaint.count() >= 1, "no complaint appeared on screen")
            check("and the complaint says something", complaint.count() >= 1 and len(complaint.first.inner_text().strip()) > 10, complaint.first.inner_text()[:120] if complaint.count() else "")
            check("and nothing was lifted", "Undone. That is line" not in page.content())

            print("-- the secret is not something the browser sends by itself")
            # The token lives in this tab's storage and is only ever attached on purpose. If it were a
            # cookie, the browser would put it on every request and any page in the app could reach these
            # endpoints. So a bare request from this very tab, holding the token, must still be refused.
            bare = page.evaluate(
                """async () => {
                    const answer = await fetch('/api/rpc/admin/catalogue', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ json: {} }),
                    });
                    return answer.status;
                }"""
            )
            check("a request that does not carry the secret on purpose is refused", bare == 403, f"answered {bare}")
            stored = page.evaluate("() => Object.keys(window.localStorage).length")
            check("the secret is not left in the browser's long-term storage", stored == 0, f"{stored} things in local storage")

            print("-- the one bulk mercy, and what it says about itself")
            # Wiping the chat record clean lifts the mute, the ban and the strikes together. It is the only
            # bulk lift on the page and it cannot be undone, because undoing mercy is not something this
            # page will do — so the warning has to be in front of the operator before they press it.
            page.get_by_role("button", name="Clear everything chat-related").click()
            check("the mercy action warns it is one way", "This cannot be undone" in page.content())
            check("and explains itself", "undoing mercy" in page.content())
            page.get_by_label("Why").fill("their account was stolen and we accepted the appeal")
            page.get_by_role("button", name="File it — one way").click()
            page.wait_for_selector("text=Filed as line", timeout=15000)
            page.wait_for_timeout(1000)
            body = page.content()
            check("the ban is gone", "Chat banned — no" in body)
            check("the mute is gone", "Muted — no" in body)
            check("the wipe is on the record like everything else", "Chat record wiped clean" in body)

            print("-- what the page tells the operator about itself")
            body = page.content()
            check(
                "the page says there is no un-ban button and why",
                "no un-ban button" in body and "undoing the line that made it" in body,
                "an operator hunting for a button that does not exist will invent a worse way",
            )
            check("the page says every line is permanent", "nobody can edit or delete" in body)
            check("the standing panel says where its numbers came from", "not read from a saved total" in body)
            check("the page counts everything on record", "Things on record" in body)

            print("-- locking up")
            page.get_by_role("button", name="Lock this page").click()
            page.wait_for_timeout(500)
            check("the page asks for the secret again", page.get_by_label("Operator secret").is_visible())
            check("locking takes the buttons away", "What can be done" not in page.content())
            check("and takes the history away", "Everything on record" not in page.content())
            page.reload(wait_until="networkidle")
            check("and a reload does not remember it", page.get_by_label("Operator secret").is_visible(), "a forgotten token must stay forgotten")

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        if os.path.exists(DB):
            os.remove(DB)

    print(f"\n{checks - failures}/{checks} checks passed")
    if failures > 0:
        print(f"FAIL — {failures} problem(s) on the break-glass page")
        sys.exit(1)
    print("PASS — the break-glass page")


main()
