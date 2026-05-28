import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Integration tests talk to real hardware/processes, so give them room.
        testTimeout: 120_000,
        hookTimeout: 30_000,
    },
});
