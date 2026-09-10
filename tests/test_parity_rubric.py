from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

from parity_rubric import evaluate


ROOT = Path(__file__).resolve().parents[1]


class ParityRubricTests(unittest.TestCase):
    def test_all_implemented_contract_rows_pass(self):
        failed = [row["id"] for row in evaluate(ROOT) if row["score"] != 1]
        self.assertEqual(failed, [])

    def test_xlsx_history_is_implemented(self):
        row = next(row for row in evaluate(ROOT) if row["id"] == "UI-05")
        self.assertEqual(row["score"], 1)

    def test_message_renderer_executes_nested_spintax_and_placeholders(self):
        script = r'''
global.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}}}};
require("./extension/common.js");
const old=Math.random; Math.random=()=>0;
const comments=[{id:"1",list_id:"L",content:"{Hi|Hello} <Username> <City>"}];
const result=DMHCore.prepareMessage(comments,"L",{username:"marta"},{City:"Kyiv"});
Math.random=old;
if(result!=="Hi marta Kyiv") throw new Error(result);
'''
        subprocess.run(["node", "-e", script], cwd=ROOT, check=True)


if __name__ == "__main__":
    unittest.main()

