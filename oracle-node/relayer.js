"use strict";

const { scaleObservation, toTuple } = require("./scaler");

/**
 * Off-chain relayer (PRD §5.1). Pulls observations from the K-Weather client, scales
 * them to fixed-point, and pushes them on-chain via the oracle contract in a single
 * batched transaction.
 */
class KWeatherRelayer {
  /**
   * @param {object} oracle  ethers Contract instance of KWeatherOracle (relayer-authorized signer)
   * @param {object} client  KWeatherClient
   * @param {(msg:string)=>void} [log]
   */
  constructor(oracle, client, log = () => {}) {
    this.oracle = oracle;
    this.client = client;
    this.log = log;
  }

  /**
   * Fetch + scale + push one round for the given regions.
   * @param {object[]} regions entries from regions.js
   * @param {number} [atUnix]  observation time (defaults to now)
   * @returns {Promise<{regionCode:number, obs:object}[]>}
   */
  async relayOnce(regions, atUnix) {
    const ts = atUnix ?? Math.floor(Date.now() / 1000);

    const codes = [];
    const tuples = [];
    const collected = [];

    for (const region of regions) {
      const obs = await this.client.fetchObservation(region, ts);
      const scaled = scaleObservation(obs);
      codes.push(region.code);
      tuples.push(toTuple(scaled));
      collected.push({ regionCode: region.code, obs });
    }

    const tx = await this.oracle.pushBatch(codes, tuples);
    const receipt = await tx.wait();
    this.log(
      `[relayer] pushed ${codes.length} regions @ ${new Date(ts * 1000).toISOString()} ` +
        `(tx ${tx.hash.slice(0, 10)}…, gas ${receipt.gasUsed})`
    );
    return collected;
  }
}

module.exports = { KWeatherRelayer };
