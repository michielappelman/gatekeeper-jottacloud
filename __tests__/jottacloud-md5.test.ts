import { describe, expect, it } from "vitest";
import { md5Hex } from "../src/jottacloud/md5";

describe("md5Hex", () => {
  it("matches the well-known MD5 of an empty buffer", () => {
    expect(md5Hex(new ArrayBuffer(0))).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("matches the well-known MD5 of 'hello world'", () => {
    expect(md5Hex(new TextEncoder().encode("hello world").buffer)).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");
  });
});
