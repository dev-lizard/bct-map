// A small GTFS-Realtime decoder, shared by the browser, the Cloudflare Worker and the Node server.
// It reads just the fields this app uses and returns them in the same shape as
// gtfs-realtime-bindings' FeedMessage.toObject({ longs: Number, enums: String }), so code written
// against that library works unchanged. Unknown fields are skipped.

const TRIP_RELATIONSHIP = { 0: 'SCHEDULED', 1: 'ADDED', 2: 'UNSCHEDULED', 3: 'CANCELED', 5: 'REPLACEMENT', 6: 'DUPLICATED', 7: 'DELETED' };
const CAUSE = {
  1: 'UNKNOWN_CAUSE', 2: 'OTHER_CAUSE', 3: 'TECHNICAL_PROBLEM', 4: 'STRIKE', 5: 'DEMONSTRATION', 6: 'ACCIDENT', 7: 'HOLIDAY',
  8: 'WEATHER', 9: 'MAINTENANCE', 10: 'CONSTRUCTION', 11: 'POLICE_ACTIVITY', 12: 'MEDICAL_EMERGENCY',
};
const EFFECT = {
  1: 'NO_SERVICE', 2: 'REDUCED_SERVICE', 3: 'SIGNIFICANT_DELAYS', 4: 'DETOUR', 5: 'ADDITIONAL_SERVICE', 6: 'MODIFIED_SERVICE',
  7: 'OTHER_EFFECT', 8: 'UNKNOWN_EFFECT', 9: 'STOP_MOVED', 10: 'NO_EFFECT', 11: 'ACCESSIBILITY_ISSUE',
};
const STOP_RELATIONSHIP = { 0: 'SCHEDULED', 1: 'SKIPPED', 2: 'NO_DATA', 3: 'UNSCHEDULED' };

const textDecoder = new TextDecoder();

// A cursor over one protobuf message (bytes[start, end)).
class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // A varint as two 32-bit halves, so 64-bit values (timestamps, negative int32s) survive.
  varint() {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      const b = this.bytes[this.pos++];
      if (shift < 28) lo |= (b & 0x7f) << shift;
      else if (shift === 28) {
        lo |= (b & 0x0f) << 28;
        hi |= (b & 0x70) >>> 4;
      } else hi |= (b & 0x7f) << (shift - 32);
      shift += 7;
      if (b < 0x80) return { lo: lo >>> 0, hi: hi >>> 0 };
    }
    throw new Error('Malformed varint');
  }

  uint() {
    const { lo, hi } = this.varint();
    return hi * 0x100000000 + lo;
  }

  // int32 / int64: negative values are sent as 64-bit two's complement.
  int() {
    const { lo, hi } = this.varint();
    if (hi & 0x80000000) return -((~hi >>> 0) * 0x100000000 + (~lo >>> 0) + 1);
    return hi * 0x100000000 + lo;
  }

  bool() {
    return this.uint() !== 0;
  }

  float() {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  double() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  // A length-delimited field as a sub-reader.
  message() {
    const len = this.uint();
    const sub = new Reader(this.bytes, this.pos, this.pos + len);
    sub.view = this.view;
    this.pos += len;
    return sub;
  }

  // Short ASCII strings (stop and trip ids, nearly everything in BCT's feeds) are built directly:
  // TextDecoder's per-call cost made it the slowest part of decoding trip updates.
  string() {
    const len = this.uint();
    const end = this.pos + len;
    if (len <= 64) {
      let s = '';
      let i = this.pos;
      for (; i < end; i++) {
        const b = this.bytes[i];
        if (b >= 0x80) break;
        s += String.fromCharCode(b);
      }
      if (i === end) {
        this.pos = end;
        return s;
      }
    }
    const s = textDecoder.decode(this.bytes.subarray(this.pos, end));
    this.pos = end;
    return s;
  }

  skip(wireType) {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) {
      const len = this.uint(); // read first: `this.pos += this.uint()` would add to the old position
      this.pos += len;
    } else if (wireType === 5) this.pos += 4;
    else throw new Error(`Unsupported wire type ${wireType}`);
  }

  // Calls fields[fieldNumber](reader) for each field present; skips the rest.
  read(fields) {
    while (this.pos < this.end) {
      const key = this.uint();
      const field = key >>> 3;
      const handler = fields[field];
      if (handler) handler(this);
      else this.skip(key & 7);
    }
  }
}

function tripDescriptor(r) {
  const t = {};
  r.read({
    1: x => { t.tripId = x.string(); },
    2: x => { t.startTime = x.string(); },
    3: x => { t.startDate = x.string(); },
    4: x => { t.scheduleRelationship = TRIP_RELATIONSHIP[x.uint()] ?? 'SCHEDULED'; },
    5: x => { t.routeId = x.string(); },
    6: x => { t.directionId = x.uint(); },
  });
  return t;
}

function vehicleDescriptor(r) {
  const v = {};
  r.read({ 1: x => { v.id = x.string(); }, 2: x => { v.label = x.string(); }, 3: x => { v.licensePlate = x.string(); } });
  return v;
}

function stopTimeEvent(r) {
  const e = {};
  r.read({ 1: x => { e.delay = x.int(); }, 2: x => { e.time = x.int(); }, 3: x => { e.uncertainty = x.int(); } });
  return e;
}

function stopTimeUpdate(r) {
  const s = {};
  r.read({
    1: x => { s.stopSequence = x.uint(); },
    2: x => { s.arrival = stopTimeEvent(x.message()); },
    3: x => { s.departure = stopTimeEvent(x.message()); },
    4: x => { s.stopId = x.string(); },
    5: x => { s.scheduleRelationship = STOP_RELATIONSHIP[x.uint()] ?? 'SCHEDULED'; },
  });
  return s;
}

function tripUpdate(r) {
  const u = { stopTimeUpdate: [] };
  r.read({
    1: x => { u.trip = tripDescriptor(x.message()); },
    2: x => { u.stopTimeUpdate.push(stopTimeUpdate(x.message())); },
    3: x => { u.vehicle = vehicleDescriptor(x.message()); },
    4: x => { u.timestamp = x.uint(); },
    5: x => { u.delay = x.int(); },
  });
  return u;
}

function position(r) {
  const p = {};
  r.read({
    1: x => { p.latitude = x.float(); },
    2: x => { p.longitude = x.float(); },
    3: x => { p.bearing = x.float(); },
    4: x => { p.odometer = x.double(); },
    5: x => { p.speed = x.float(); },
  });
  return p;
}

function vehiclePosition(r) {
  const v = {};
  r.read({
    1: x => { v.trip = tripDescriptor(x.message()); },
    2: x => { v.position = position(x.message()); },
    3: x => { v.currentStopSequence = x.uint(); },
    5: x => { v.timestamp = x.uint(); },
    7: x => { v.stopId = x.string(); },
    8: x => { v.vehicle = vehicleDescriptor(x.message()); },
  });
  return v;
}

function translatedString(r) {
  const translation = [];
  r.read({
    1: x => {
      const t = {};
      x.message().read({ 1: y => { t.text = y.string(); }, 2: y => { t.language = y.string(); } });
      translation.push(t);
    },
  });
  return { translation };
}

function alert(r) {
  const a = { activePeriod: [], informedEntity: [] };
  r.read({
    1: x => {
      const p = {};
      x.message().read({ 1: y => { p.start = y.uint(); }, 2: y => { p.end = y.uint(); } });
      a.activePeriod.push(p);
    },
    5: x => {
      const e = {};
      x.message().read({
        1: y => { e.agencyId = y.string(); },
        2: y => { e.routeId = y.string(); },
        3: y => { e.routeType = y.int(); },
        4: y => { e.trip = tripDescriptor(y.message()); },
        5: y => { e.stopId = y.string(); },
      });
      a.informedEntity.push(e);
    },
    6: x => { a.cause = CAUSE[x.uint()] ?? 'UNKNOWN_CAUSE'; },
    7: x => { a.effect = EFFECT[x.uint()] ?? 'UNKNOWN_EFFECT'; },
    8: x => { a.url = translatedString(x.message()); },
    10: x => { a.headerText = translatedString(x.message()); },
    11: x => { a.descriptionText = translatedString(x.message()); },
  });
  return a;
}

// bytes: a Uint8Array holding one serialized FeedMessage.
export function decodeFeed(bytes) {
  const feed = { header: {}, entity: [] };
  new Reader(bytes).read({
    1: x => {
      x.message().read({
        1: y => { feed.header.gtfsRealtimeVersion = y.string(); },
        2: y => { feed.header.incrementality = y.uint() === 1 ? 'DIFFERENTIAL' : 'FULL_DATASET'; },
        3: y => { feed.header.timestamp = y.uint(); },
      });
    },
    2: x => {
      const e = {};
      x.message().read({
        1: y => { e.id = y.string(); },
        2: y => { e.isDeleted = y.bool(); },
        3: y => { e.tripUpdate = tripUpdate(y.message()); },
        4: y => { e.vehicle = vehiclePosition(y.message()); },
        5: y => { e.alert = alert(y.message()); },
      });
      feed.entity.push(e);
    },
  });
  return feed;
}

// ---- The /api/rt bundle: BCT's feeds in one response -----------------------------------------
// A run of parts, each [1-byte kind][4-byte big-endian length][one serialized FeedMessage]. Kinds:
// 1 vehicle positions, 2 trip updates, 3 alerts, 4 an older vehicle-positions feed (any number,
// oldest first; they let a page that has just opened animate buses from where they were). A feed
// that was unavailable is simply left out.

const KINDS = { vehiclePositions: 1, tripUpdates: 2, alerts: 3, history: 4 };

// parts: { vehiclePositions, tripUpdates, alerts: Uint8Array or null, history: [Uint8Array] }
export function packBundle({ vehiclePositions = null, tripUpdates = null, alerts = null, history = [] }) {
  const list = [...history.map(b => [KINDS.history, b]), [KINDS.vehiclePositions, vehiclePositions], [KINDS.tripUpdates, tripUpdates], [KINDS.alerts, alerts]]
    .filter(([, bytes]) => bytes?.length);
  const out = new Uint8Array(list.reduce((n, [, b]) => n + 5 + b.length, 0));
  const view = new DataView(out.buffer);
  let pos = 0;
  for (const [kind, bytes] of list) {
    view.setUint8(pos, kind);
    view.setUint32(pos + 1, bytes.length);
    out.set(bytes, pos + 5);
    pos += 5 + bytes.length;
  }
  return out;
}

// -> { vehiclePositions, tripUpdates, alerts: decoded feed or null, history: [decoded feed] }.
// decode: false returns the raw bytes instead; history: false skips the older feeds.
export function unpackBundle(bytes, { decode = true, history = true } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { vehiclePositions: null, tripUpdates: null, alerts: null, history: [] };
  const names = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));
  let pos = 0;
  while (pos + 5 <= bytes.length) {
    const kind = view.getUint8(pos);
    const len = view.getUint32(pos + 1);
    const part = bytes.subarray(pos + 5, pos + 5 + len);
    if (kind === KINDS.history) {
      if (history) out.history.push(decode ? decodeFeed(part) : part);
    } else if (names[kind]) {
      out[names[kind]] = decode ? decodeFeed(part) : part;
    }
    pos += 5 + len;
  }
  return out;
}

// The feed header's timestamp, without decoding the rest. A merged feed (server/bct-feed.mjs) has a
// header from each part; as when decoding, the last one wins.
export function feedTimestamp(bytes) {
  const r = new Reader(bytes);
  let ts = null;
  while (r.pos < r.end) {
    const key = r.uint();
    if (key >>> 3 === 1 && (key & 7) === 2) r.message().read({ 3: y => { ts = y.uint(); } });
    else r.skip(key & 7);
  }
  return ts;
}
