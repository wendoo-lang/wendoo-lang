FROM node:22-alpine AS builder

WORKDIR /workspace

# Copy bridge-protocol (local dependency of vscode-bridge)
COPY packages/bridge-protocol/package.json packages/bridge-protocol/package.json
COPY packages/bridge-protocol/tsconfig.json packages/bridge-protocol/tsconfig.json
COPY packages/bridge-protocol/src packages/bridge-protocol/src

# Copy join-codes (local dependency of vscode-bridge)
COPY packages/join-codes/package.json packages/join-codes/package.json
COPY packages/join-codes/tsconfig.json packages/join-codes/tsconfig.json
COPY packages/join-codes/src packages/join-codes/src

# Copy bridge-session (local dependency of vscode-bridge)
COPY packages/bridge-session/package.json packages/bridge-session/package.json
COPY packages/bridge-session/tsconfig.json packages/bridge-session/tsconfig.json
COPY packages/bridge-session/src packages/bridge-session/src

# Copy vscode-bridge
COPY apps/vscode-bridge/package.json apps/vscode-bridge/package.json
COPY apps/vscode-bridge/tsconfig.json apps/vscode-bridge/tsconfig.json
COPY apps/vscode-bridge/tsconfig.base.json apps/vscode-bridge/tsconfig.base.json
COPY apps/vscode-bridge/src apps/vscode-bridge/src

# Build bridge-protocol first
WORKDIR /workspace/packages/bridge-protocol
RUN npm install && npm run build

# Build join-codes
WORKDIR /workspace/packages/join-codes
RUN npm install && npm run build

# Build bridge-session
WORKDIR /workspace/packages/bridge-session
RUN npm install && npm run build

# Build vscode-bridge
WORKDIR /workspace/apps/vscode-bridge
RUN npm install && npm run build

# ---- Production stage ----
FROM node:22-alpine

WORKDIR /workspace

# Copy built bridge-protocol (needed at runtime via file: reference)
COPY --from=builder /workspace/packages/bridge-protocol/package.json packages/bridge-protocol/package.json
COPY --from=builder /workspace/packages/bridge-protocol/dist packages/bridge-protocol/dist

# Copy built join-codes (needed at runtime via file: reference)
COPY --from=builder /workspace/packages/join-codes/package.json packages/join-codes/package.json
COPY --from=builder /workspace/packages/join-codes/dist packages/join-codes/dist

# Copy built bridge-session (needed at runtime via file: reference)
COPY --from=builder /workspace/packages/bridge-session/package.json packages/bridge-session/package.json
COPY --from=builder /workspace/packages/bridge-session/dist packages/bridge-session/dist

# Copy built vscode-bridge
COPY --from=builder /workspace/apps/vscode-bridge/package.json apps/vscode-bridge/package.json
COPY --from=builder /workspace/apps/vscode-bridge/dist apps/vscode-bridge/dist

# Install deps for each package so transitive dependencies are resolved
WORKDIR /workspace/packages/bridge-protocol
RUN npm install --omit=dev

WORKDIR /workspace/packages/bridge-session
RUN npm install --omit=dev

WORKDIR /workspace/apps/vscode-bridge
RUN npm install --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
