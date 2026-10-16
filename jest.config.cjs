module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  transform: {
    // ts-jest runs tsc, which emits the decorator metadata GOAT's @Tool decorator reads.
    "^.+\\.ts$": ["ts-jest", { tsconfig: { experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, target: "ES2022" } }],
  },
  collectCoverage: true,
  collectCoverageFrom: ["./src/**/*.ts", "!./src/**/*.test.ts", "!./src/index.ts"],
  coverageReporters: ["text", "text-summary"],
};
