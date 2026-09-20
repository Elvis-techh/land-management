import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sortContracts } from "../src/features/contracts/contractSort";
import type { Contract } from "../src/types";

const contract = (code: string, projectName: string): Contract =>
  ({
    id: code,
    code,
    customer: { id: code, fullName: code },
    lot: { id: code, code, projectName },
    health: { status: "current" },
    balance: 0,
  }) as unknown as Contract;

describe("sortContracts — project", () => {
  it("orders by the lot's project name", () => {
    const rows = [
      contract("CT-1", "Monte Real"),
      contract("CT-2", "Valle Verde"),
      contract("CT-3", "Alameda"),
    ];

    const ordered = sortContracts(rows, [{ field: "project", direction: "asc" }]);

    assert.deepEqual(
      ordered.map((row) => row.lot.projectName),
      ["Alameda", "Monte Real", "Valle Verde"],
    );
  });
});
