import { GraphBackend } from "../../src/graph/backend.js";
import { encodeShortId } from "../../src/graph/shortid.js";
import { FakeGraph } from "../fakes/fakeGraph.js";
import { runMailBackendContract } from "./suite.js";

const fake = new FakeGraph();
let counter = 0;

runMailBackendContract({
  name: "graph",
  makeBackend: async () => {
    const baseUrl = await fake.start();
    const backend = new GraphBackend("suite", {
      backend: "graph", address: "Agent <school@school.test>",
      graph: { tenant_id: "t", client_id: "c" },
    }, { baseUrl, mailboxName: "suite", getToken: async () => "tok" });
    return { backend, cleanup: async () => { await backend.close(); await fake.stop(); } };
  },
  seed: async (subject, body) => {
    counter += 1;
    fake.seed({
      folder: "inbox", subject, fromName: "Seeder", fromAddress: "seed@x.test",
      body, isRead: false, receivedAt: new Date(1_754_800_000_000 + counter * 5000), headers: {},
    });
  },
  bogusId: encodeShortId("no-such-native-id", new Date(1_700_000_000_000)),
  selfAddress: { name: "Agent", address: "school@school.test" },
});
