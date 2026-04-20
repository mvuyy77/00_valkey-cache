FROM node:22-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ src/
COPY benchmarks/ benchmarks/

HEALTHCHECK --interval=2s --timeout=3s --retries=10 \
  CMD node -e "fetch('http://localhost:3000/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "tsx", "benchmarks/k6/app-server.ts"]
