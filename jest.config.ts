import type { JestConfigWithTsJest } from "ts-jest";

export default {
  extensionsToTreatAsEsm: [".ts"],
  modulePathIgnorePatterns: ["<rootDir>/dist"],
  preset: "ts-jest",
  setupFilesAfterEnv: ["jest-extended/all", "<rootDir>/test/common.ts"],
  testEnvironment: "<rootDir>/test/MatrixEnvironment.mjs",
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        compiler: "ttypescript",
        plugins: [{ transform: "typia/lib/transform" }],
        useESM: true,
      },
    ],
  },
} satisfies JestConfigWithTsJest;
