
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FootballToolsController } from "./interface/controllers/footballToolsController.js";
import { BettingToolsController } from "./interface/controllers/bettingToolsController.js";
import { LeagueScanController } from "./interface/controllers/leagueScanController.js";
import { DailySlateController } from "./interface/controllers/dailySlateController.js";
import { BasketballSlateController } from "./interface/controllers/basketballSlateController.js";
import { FootballDataService, OddsPapiService, BallDontLieService } from "./infrastructure/services/liveSources.js";
import { FootballApiService } from "./infrastructure/services/footballApiService.js";
import { FootballService } from "./application/services/footballService.js";


async function main() {
  const server = new McpServer({
    name: "football",
    version: "0.1.0",
    capabilities: {
      resources: {},
      tools: {}, // habilita registerTool()
    },
  });

  // injeta serviços e registra ferramentas
  const api = new FootballApiService();
  const footballService = new FootballService(api);
  new FootballToolsController(server, footballService);
  new BettingToolsController(server, api);
  new LeagueScanController(server, api);
  const oddsPapi = new OddsPapiService();
  new DailySlateController(server, new FootballDataService(), oddsPapi);
  new BasketballSlateController(server, new BallDontLieService(), oddsPapi);

  // transport stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("⚽ MCP Football Server rodando em STDIO");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
