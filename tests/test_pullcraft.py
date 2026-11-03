import datetime as dt
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_world as bw  # noqa: E402
import pullcraft as pc  # noqa: E402
import validate_pr as vp  # noqa: E402

CFG = pc.load_config(ROOT)
BLOCKS = pc.load_blocks(ROOT)
PLACEABLE = set(pc.block_ids(BLOCKS, placeable_only=True))


def doc(blocks, **kw):
    return {"version": 1, "title": "T", "blocks": blocks, **kw}


class Spiral(unittest.TestCase):
    def test_unique_and_adjacent(self):
        cells = [pc.spiral(n) for n in range(1, 2000)]
        self.assertEqual(len(set(cells)), len(cells))
        self.assertEqual(cells[0], (0, 0))
        for a, b in zip(cells, cells[1:]):
            self.assertEqual(abs(a[0] - b[0]) + abs(a[1] - b[1]), 1)

    def test_origin_layout(self):
        w = CFG["world"]
        ox, oz = pc.plot_origin(w, (0, 0))
        self.assertEqual((ox, oz), (-16, -16))  # 32-block plot centred on the origin
        self.assertEqual(pc.plot_origin(w, (1, 0))[0] - ox, pc.cell_size(w))


class Validation(unittest.TestCase):
    def check(self, d):
        return pc.validate_content(d, CFG, PLACEABLE)[0]

    def test_ok(self):
        self.assertEqual(self.check(doc([[0, 0, 0, "stone"], [31, 63, 31, "glass"]])), [])

    def test_rejects(self):
        for bad in (
            doc([[32, 0, 0, "stone"]]), doc([[0, 64, 0, "stone"]]), doc([[-1, 0, 0, "stone"]]),
            doc([[0, 0, 0, "water"]]), doc([[0, 0, 0, "nope"]]), doc([[0, 0, 0, "stone"], [0, 0, 0, "dirt"]]),
            doc([[0.5, 0, 0, "stone"]]), doc([[True, 0, 0, "stone"]]), doc("x"), doc([[0, 0, 0]]),
            doc([], title="<script>"), doc([], extra=1), {"version": 2, "blocks": []}, [],
        ):
            self.assertTrue(self.check(bad), bad)

    def test_block_limit(self):
        many = [[x % 32, (x // 32) % 64, x // 2048, "stone"] for x in range(CFG["rules"]["max_blocks"] + 1)]
        self.assertTrue(self.check(doc(many)))

    def test_pointer(self):
        remote = doc([[1, 1, 1, "stone"]])
        fetch = lambda repo, sha, path: remote  # noqa: E731
        ptr = {"version": 1, "source": {"repo": "alice/b", "path": "plot.json", "sha": "a" * 40}}
        errs, stats, res = pc.validate_document(ptr, "alice", CFG, PLACEABLE, fetch)
        self.assertEqual((errs, stats.kind, res), ([], "repo", remote))
        self.assertTrue(pc.validate_document(ptr, "mallory", CFG, PLACEABLE, fetch)[0])  # not your repo
        bad_sha = {**ptr, "source": {**ptr["source"], "sha": "main"}}
        self.assertTrue(pc.validate_document(bad_sha, "alice", CFG, PLACEABLE, fetch)[0])
        trav = {**ptr, "source": {**ptr["source"], "path": "../x.json"}}
        self.assertTrue(pc.validate_document(trav, "alice", CFG, PLACEABLE, fetch)[0])

        def boom(*a):
            raise OSError("network down")
        self.assertTrue(pc.validate_document(ptr, "alice", CFG, PLACEABLE, boom)[0])
        invalid_remote = lambda *a: doc([[99, 0, 0, "stone"]])  # noqa: E731
        self.assertTrue(pc.validate_document(ptr, "alice", CFG, PLACEABLE, invalid_remote)[0])


class PullRequestRules(unittest.TestCase):
    OLD = dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc)

    def ev(self, login="alice", files=None, body=None, assoc="NONE", created=OLD, existing=()):
        files = files if files is not None else [{"filename": f"plots/{login}.json", "status": "added"}]
        raw = json.dumps(body if body is not None else doc([[0, 0, 0, "stone"]])).encode()
        return vp.evaluate(login, assoc, files, lambda p: raw, set(existing), created, CFG, PLACEABLE)

    def test_happy(self):
        self.assertEqual(self.ev().kind, "approved")

    def test_other_players_file(self):
        v = self.ev(files=[{"filename": "plots/bob.json", "status": "modified"}])
        self.assertEqual(v.kind, "rejected")

    def test_mixed_files_and_traversal(self):
        for name in ("plots/alice.json/../bob.json", "plots/sub/alice.json", "plots/Alice.json"):
            self.assertEqual(self.ev(files=[{"filename": name, "status": "added"}]).kind, "rejected", name)

    def test_code_changes_need_review(self):
        v = self.ev(files=[{"filename": "scripts/validate_pr.py", "status": "modified"}])
        self.assertEqual(v.kind, "manual")
        v = self.ev(files=[{"filename": "plots/alice.json", "status": "added"}, {"filename": ".github/workflows/x.yml", "status": "added"}])
        self.assertEqual(v.kind, "manual")

    def test_delete_and_rename_blocked(self):
        for st in ("removed", "renamed"):
            self.assertEqual(self.ev(files=[{"filename": "plots/alice.json", "status": st}]).kind, "rejected")

    def test_new_account(self):
        now = dt.datetime.now(dt.timezone.utc)
        self.assertEqual(self.ev(created=now).kind, "rejected")
        self.assertEqual(self.ev(created=now, assoc="OWNER").kind, "approved")

    def test_case_clash(self):
        self.assertEqual(self.ev(existing={"plots/Alice.json"}, login="alice").kind, "rejected")

    def test_css_and_xml_files(self):
        css = b":root{--title: Hut;} .a{shape:box; width:3; height:3; depth:3; block:stone;}"
        for ext, raw in (("css", css), ("xml", b'<plot title="x"><box w="2" h="2" d="2" block="stone"/></plot>')):
            files = [{"filename": f"plots/alice.{ext}", "status": "added"}]
            v = vp.evaluate("alice", "NONE", files, lambda p: raw, set(), self.OLD, CFG, PLACEABLE)
            self.assertEqual(v.kind, "approved", v.errors)

    def test_bad_blueprint_rejected(self):
        files = [{"filename": "plots/alice.css", "status": "added"}]
        v = vp.evaluate("alice", "NONE", files, lambda p: b".a{block:nope;}", set(), self.OLD, CFG, PLACEABLE)
        self.assertEqual(v.kind, "rejected")

    def test_format_switch_and_double_files(self):
        raw = b".a{shape:box; block:stone;}"
        switch = [{"filename": "plots/alice.json", "status": "removed"}, {"filename": "plots/alice.css", "status": "added"}]
        v = vp.evaluate("alice", "NONE", switch, lambda p: raw, {"plots/alice.json"}, self.OLD, CFG, PLACEABLE)
        self.assertEqual(v.kind, "approved", v.errors)
        rename = [{"filename": "plots/alice.css", "status": "renamed", "previous_filename": "plots/alice.json"}]
        v = vp.evaluate("alice", "NONE", rename, lambda p: raw, {"plots/alice.json"}, self.OLD, CFG, PLACEABLE)
        self.assertEqual(v.kind, "approved", v.errors)
        both = [{"filename": "plots/alice.css", "status": "added"}]
        v = vp.evaluate("alice", "NONE", both, lambda p: raw, {"plots/alice.json"}, self.OLD, CFG, PLACEABLE)
        self.assertEqual(v.kind, "rejected")
        only_delete = [{"filename": "plots/alice.json", "status": "removed"}]
        v = vp.evaluate("alice", "NONE", only_delete, lambda p: raw, {"plots/alice.json"}, self.OLD, CFG, PLACEABLE)
        self.assertEqual(v.kind, "rejected")

    def test_invalid_content(self):
        self.assertEqual(self.ev(body=doc([[40, 0, 0, "stone"]])).kind, "rejected")


import blueprint as bp  # noqa: E402


class Blueprints(unittest.TestCase):
    def comp(self, fmt, src):
        return bp.compile_blueprint(fmt, src, CFG, PLACEABLE)

    def test_examples_compile(self):
        for f in sorted((ROOT / "examples").iterdir()):
            errors, meta, blocks = self.comp(f.suffix[1:], f.read_text())
            self.assertEqual(errors, [], f.name)
            self.assertTrue(meta["title"] and blocks, f.name)

    def test_css_semantics(self):
        e, _, b = self.comp("css", ".a{shape:box;x:1;y:2;z:3;width:2;height:1;depth:1;block:stone} .b{x:1;y:2;z:3;block:air}")
        self.assertEqual((e, b), ([], [[2, 2, 3, "stone"]]))  # later rule carves
        e, _, b = self.comp("css", ":root{--m:glass} .a{block:var(--m);w:2;repeat:3;gap:1}")
        self.assertEqual([x[0] for x in b], [0, 1, 3, 4, 6, 7])
        _, _, b = self.comp("css", ".a{shape:box;x:30;width:10;block:stone}")
        self.assertEqual(len(b), 2)  # clipped to the plot

    def test_shapes(self):
        n = lambda shape, w, h, d: len(self.comp("css", f".a{{shape:{shape};w:{w};h:{h};d:{d};block:stone}}")[2])  # noqa: E731
        self.assertEqual(n("box", 3, 3, 3), 27)
        self.assertEqual(n("shell", 3, 3, 3), 26)
        self.assertEqual(n("walls", 3, 2, 3), 16)
        self.assertEqual(n("pyramid", 3, 2, 3), 9 + 1)
        self.assertEqual(n("cylinder", 1, 1, 1), 1)
        self.assertTrue(0 < n("sphere", 9, 9, 9) < 729 and 0 < n("dome", 9, 5, 9) < 405)

    def test_errors_are_specific(self):
        for fmt, src, needle in [
            ("css", ".a{block:nope}", "unknown or non-placeable"), ("css", ".a{block:stone;colour:red}", "unknown property"),
            ("css", ".a{block:stone;width:abc}", "whole number"), ("css", ".a{block:stone;width:9999}", "between"),
            ("css", ".a{block:var(--x)}", "undefined variable"), ("css", "@media x{.a{block:stone}}", "nested"),
            ("css", ".a{block:stone", "missing"), ("css", "/* open", "Unterminated"), ("css", ".a{shape:cube;block:stone}", "shape must"),
            ("css", ".a{block:water}", "non-placeable"), ("css", "", "empty"), ("css", ":root{--a:b}", "no shapes"),
            ("xml", "<plot><box block='stone'", "XML error"), ("xml", "<scene/>", "root element"),
            ("xml", "<plot><box block='$q'/></plot>", "undefined variable"), ("xml", "<plot><wat/></plot>", "unknown element"),
            ("xml", '<!DOCTYPE x [<!ENTITY a "b">]><plot/>', "DOCTYPE"), ("xml", "<plot><box/></plot>", "missing 'block'"),
            ("css", ".a{block:stone;width:256;height:64;depth:256;repeat-x:1000}", "too many|Too many|too complex|complex"),
        ]:
            errors = self.comp(fmt, src)[0]
            self.assertTrue(errors, src)
            import re as _re
            self.assertTrue(any(_re.search(needle, e, _re.I) for e in errors), (src, errors))

    def test_limits(self):
        errs = self.comp("css", ".a{block:stone}" * 5000)[0]
        self.assertTrue(errs)  # too long
        big = ".a{block:stone}" * 2100
        self.assertTrue(any("Too many shapes" in e for e in self.comp("css", big)[0]))
        t = self.comp("xml", "<plot>" + "<group>" * 7 + "<box block='stone'/>" + "</group>" * 7 + "</plot>")[0]
        self.assertTrue(any("nested too deeply" in e for e in t))

    def test_document_formats(self):
        d = {"version": 1, "format": "css", "source": ".a{block:stone;w:2;h:2;d:2}", "title": "Cube"}
        errs, stats, res = pc.validate_document(d, "alice", CFG, PLACEABLE)
        self.assertEqual((errs, stats.blocks, stats.format, stats.title), ([], 8, "css", "Cube"))
        self.assertEqual(res["format"], "css")
        self.assertTrue(pc.validate_document({**d, "extra": 1}, "alice", CFG, PLACEABLE)[0])
        ptr = {"version": 1, "source": {"repo": "alice/b", "path": "plot.css", "sha": "a" * 40}}
        errs, stats, res = pc.validate_document(ptr, "alice", CFG, PLACEABLE, lambda *a: ".a{block:stone}")
        self.assertEqual((errs, stats.kind, stats.format), ([], "repo", "css"))


class Builder(unittest.TestCase):
    def make_root(self, plots):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        for d in ("data", "web", "plots"):
            (tmp / d).mkdir()
        shutil.copy(ROOT / "config.json", tmp / "config.json")
        shutil.copy(ROOT / "data" / "blocks.json", tmp / "data" / "blocks.json")
        (tmp / "web" / "index.html").write_text("<html></html>")
        for name, d in plots.items():
            (tmp / "plots" / f"{name}.json").write_text(json.dumps(d))
        return tmp

    def build(self, plots, events=()):
        root = self.make_root(plots)
        out = root / "site"
        m = bw.build(root, out, fetch=lambda *a: None, events=list(events), repo="o/r")
        return root, out, m

    def test_end_to_end(self):
        ev = [{"user": "zed", "status": "A", "sha": "1" * 40, "ts": 100, "author": "zed", "subject": "Update plot: zed (#1)", "pr": 1},
              {"user": "amy", "status": "A", "sha": "2" * 40, "ts": 200, "author": "amy", "subject": "Update plot: amy (#2)", "pr": 2}]
        plots = {"amy": doc([[0, 0, 0, "stone"], [31, 5, 31, "glass"]]), "zed": doc([[1, 1, 1, "gold_block"]]),
                 "bad": doc([[99, 0, 0, "stone"]])}
        root, out, m = self.build(plots, ev)
        self.assertEqual([p["user"] for p in m["plots"]], ["zed", "amy"])  # first merged gets first slot
        self.assertEqual(m["plots"][0]["cell"], list(pc.spiral(2)))
        self.assertEqual(m["stats"]["players"], 2)
        self.assertTrue((out / "index.html").exists() and (out / ".nojekyll").exists())
        for key, h in m["chunks"].items():
            data = json.loads((out / "world" / "chunks" / f"{key}.{h}.json").read_text())
            self.assertEqual(len(data["b"]) % 4, 0)
            for i in range(0, len(data["b"]), 4):
                lx, y, lz, pid = data["b"][i:i + 4]
                self.assertTrue(0 <= lx < 16 and 0 <= lz < 16 and 0 <= y < 128 and 1 <= pid <= len(m["palette"]))
        p = json.loads((out / "world" / "players" / "amy.json").read_text())
        self.assertEqual([h["pr"] for h in p["history"]], [2])  # history comes from the git events
        self.assertTrue((out / "world" / "plots" / "amy.json").exists())
        self.assertGreaterEqual((2 * m["city_ring"] + 1) ** 2 - 1 - 2, CFG["rules"]["min_free_plots"])

    def test_code_plots_in_world(self):
        root = self.make_root({"amy": doc([[0, 0, 0, "stone"]])})
        (root / "plots" / "bob.css").write_text(":root{--title: Bob Box} .a{block:gold_block;w:2;h:2;d:2}")
        (root / "plots" / "cy.xml").write_text("<plot title='Cy'><box block='glass' w='3' h='1' d='3'/></plot>")
        (root / "plots" / "amy.css").write_text(".a{block:stone}")  # second file for amy: only one is used
        (root / "examples").mkdir()
        (root / "examples" / "x.css").write_text(".a{block:stone}")
        out = root / "site"
        m = bw.build(root, out, fetch=lambda *a: None, events=[], repo="o/r")
        fmt = {p["user"]: p["format"] for p in m["plots"]}
        self.assertEqual(fmt, {"amy": "css", "bob": "css", "cy": "xml"})  # alphabetical: amy.css wins over amy.json
        bob = json.loads((out / "world" / "plots" / "bob.json").read_text())
        self.assertEqual((bob["format"], len(bob["blocks"])), ("css", 8))
        self.assertIn("gold_block", bob["source"])
        self.assertTrue((out / "examples" / "x.css").exists())

    def test_deterministic_and_negative_chunks(self):
        plots = {"amy": doc([[0, 0, 0, "stone"]])}
        _, out1, m1 = self.build(plots)
        _, out2, m2 = self.build(plots)
        self.assertEqual(m1["revision"], m2["revision"])
        self.assertTrue(any(k.startswith("-") or "_-" in k for k in m1["chunks"]))  # spawn straddles origin

    def test_block_lands_where_layout_says(self):
        _, out, m = self.build({"amy": doc([[3, 7, 5, "gold_block"]])})
        ox, oz = m["plots"][0]["origin"]
        wx, wy, wz = ox + 3, CFG["world"]["ground"] + 1 + 7, oz + 5
        cx, cz = wx // 16, wz // 16
        data = json.loads((out / "world" / "chunks" / f"{cx}_{cz}.{m['chunks'][f'{cx}_{cz}']}.json").read_text())
        gold = m["palette"].index("gold_block") + 1
        triples = {(data["b"][i], data["b"][i + 1], data["b"][i + 2]) for i in range(0, len(data["b"]), 4) if data["b"][i + 3] == gold}
        self.assertIn((wx - cx * 16, wy, wz - cz * 16), triples)


if __name__ == "__main__":
    unittest.main()
