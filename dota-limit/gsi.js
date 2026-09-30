// The Game State Integration file that tells Dota 2 where to send live match data.
const path = require("path");

const GSI_FILENAME = "gamestate_integration_dotalimit.cfg";

function gsiPath(dotaDir) {
  return path.join(dotaDir, "game", "dota", "cfg", "gamestate_integration", GSI_FILENAME);
}

function gsiConfig(port) {
  return `"Dota Limit"
{
  "uri"       "http://127.0.0.1:${port}/"
  "timeout"   "5.0"
  "buffer"    "0.1"
  "throttle"  "0.5"
  "heartbeat" "30.0"
  "data"
  {
    "provider" "1"
    "map"      "1"
    "player"   "1"
    "hero"     "1"
    "items"    "1"
  }
}
`;
}

module.exports = { gsiPath, gsiConfig };
