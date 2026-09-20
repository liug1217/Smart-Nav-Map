// TTL / window constants for the presence system.
// All values in milliseconds unless the name ends in _S (seconds).

module.exports = {
  HEARTBEAT_TTL_MS:  45 * 1000,  // session expires 45s after last heartbeat
  CONTRIB_TTL_MS:     5 * 60 * 1000,  // trafficSource badge lasts 5 min after last valid sample
  SEG_ACTIVE_MS:     30 * 60 * 1000,  // segment kept in traffic:segs index for 30 min
};
