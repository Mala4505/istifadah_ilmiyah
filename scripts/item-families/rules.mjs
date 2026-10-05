// Item-family rules for rate_reference descriptions (docs/report-data-gaps-plan.md Phase 2).
//
// Three levels: category (spend charts) -> family = item type (what rate reports compare,
// e.g. cpvc-elbow) -> item = family + size read from the bill text (item_catalog.spec).
// Plumbing pipes/fittings are built as material + type because a CPVC and a PVC elbow are
// different prices. Ordered: first match wins.
//
// These rules only PROPOSE a mapping. generate.mjs turns it into a migration that writes
// exact item_alias rows; the database itself never runs these regexes, so new descriptions
// stay unassigned until someone adds an alias (no fuzzy matching -- 20260814000001).
// First match wins within the ordered list. Plumbing fittings are built as material + type.
const CATS = {
  venue: 'Venue structures',
  electrical: 'Electrical & power',
  plumbing: 'Plumbing',
  ac: 'AC & ventilation',
  transport: 'Transport & vehicles',
  manpower: 'Manpower & security',
  food: 'Food & kitchen',
  fuel: 'Fuel & gas',
  housekeeping: 'Housekeeping & disposables',
  office: 'Stationery, IT & media',
  civil: 'Civil, steel & carpentry',
  misc: 'Fees, tax & misc',
};

// [category, familyKey, label, unit, comparable, regex-on-normalised-text, sized?]
const F = [
  // ---- misc / tax first: these are misread lines, never items
  ['misc', 'tax-line', 'Tax line read as an item', null, false, /^(cgst|sgst|igst|gst|vat)\b|output room rent|^gst /],
  ['plumbing', 'plumbing-works', 'Plumbing / pipeline works (lump sum)', null, false, /sanitary plumbing items|sanitry|pipeline|plumbing|refitting|drainage|basin counter/],
  ['plumbing', 'ro-plant', 'RO water plant', 'nos', true, /\bro water plant|\br o installing/, true],
  ['misc', 'consultancy-training', 'Consultancy / training / audit', null, false, /consultancy|training|auditor|drawing work|autocad|notary/],
  ['ac', 'ac-installation', 'AC installation / copper piping / accessories', null, false, /a c machine|ac sater|outdoor unit|copper pipe for ac|ac ke liye/],
  ['ac', 'ac-unit-hire-supply', 'AC unit (hire / supply)', 'ton', true, /^(?!.*cabl)(?=.*(air ?condition|aircondis|split ac|\bac\b|ductable|\btr\b.*inverter|carrier))/, true],
  ['food', 'catering-meals', 'Catering / meals / refreshments', null, false, /sandwich|poha|\bqty\b|breakfast|lunch|dinner|meal|refreshment/],
  ['housekeeping', 'kitchen-equipment', 'Kitchen equipment', 'nos', true, /^(?!.*speaker)(?=.*(induction|steam boiler|mixer(?! ch)))/],
  // ---- manpower
  ['manpower', 'bouncer-shift', 'Bouncer shift', 'person', true, /bouncer/],
  ['manpower', 'security-guard-shift', 'Security guard shift', 'person', true, /security guard|body ?guard|security/],
  ['manpower', 'security-shift-unspecified', 'Security shift (role not stated)', 'person', true, /\b(morning|night)\b.*\b(night|morning)\b/],
  // ---- venue (before labour: "hanger tent inclusive of ... labour")
  ['venue', 'german-hanger', 'German hanger structure', 'sqft', true, /german|hanger tent|aluminium structure|aluminum hanger|hanger (mtr|ft)|feet multiply|super structure/],
  ['venue', 'dome-structure', 'Dome structure', 'nos', true, /\bdomes?\b|gumbaj/],
  ['venue', 'pandal-shamiyana', 'Pandal / shamiyana / tent', 'sqft', true, /pandal|shamiyana|\btent\b/],
  ['venue', 'waterproof-mandap', 'Water-proof mandap', 'sqft', true, /mandap|manday|patrawala/],
  ['venue', 'partition-wall', 'Partition wall', 'sqft', true, /partition|partican|railway (sheet|seat)|cabin/],
  ['venue', 'wooden-flooring', 'Wooden flooring', 'sqft', true, /flooring/],
  ['venue', 'wooden-platform', 'Wooden platform', 'sqft', true, /platform|platfrom|plateform|plaeform/],
  ['venue', 'cloth-ceiling-drape', 'Cloth ceiling / drape / wrapping', 'sqft', true, /cloth (ceiling|wrapping|drapping)|drapp?ing|cloth jazam|katar pana|wall covering|parda/],
  ['venue', 'carpet-grass', 'Carpet / artificial grass', 'sqft', true, /carpet|grass/],
  ['venue', 'door', 'Door', 'nos', true, /^(?!.*(hinge|w door))(?=.*\bdoors?\b)/],
  // ---- manpower / services (lump sums)
  ['manpower', 'labour-supply', 'Labour supply (lump sum)', null, false, /\blabou?rs?\b|\blabor\b|labaur|laboury|majuri|over ?time|hajri|helpers?\b|carpenter work|plumber work/],
  ['manpower', 'office-staff', 'Office staff / peon / technician', 'day', true, /^(?!.*screen)(?=.*(peon|technician|house keeper))/],
  ['manpower', 'cleaning-service', 'Cleaning & waste service', null, false, /cleaning|waste management|kachr|garbage pick|dumper/],
  ['manpower', 'pest-control', 'Pest control', null, false, /pest control/],
  // ---- transport
  ['transport', 'bus-hire', 'Bus hire', 'trip', true, /\bbus service|bus hire|\bbuses\b/],
  ['transport', 'car-hire', 'Car hire (Ertiga / sedan)', 'day', true, /ertiga|sedan|innova|\bcars?\b|hatchback|estigu|estheu|eohgu/],
  ['transport', 'auto-fare', 'Auto-rickshaw fare', 'trip', true, /auto fare|\bauto\b/],
  ['transport', 'jcb-hire', 'JCB hire', 'hour', true, /\bjcb\b/],
  ['transport', 'tractor-trip', 'Tractor trip', 'trip', true, /tractor|traktor/],
  ['transport', 'crane-forklift-hire', 'Crane / hydra / forklift hire', 'day', true, /crane(?! labour)|hydra|forklift/],
  ['transport', 'tempo-hire', 'Tempo hire', 'trip', false, /tempo|tampo/],
  ['transport', 'freight-transport', 'Freight / transport (lump sum)', null, false, /transp(?!arent)|trasp|trans charges|trucks?\b|freight|loading|unloading|courier/],
  // ---- fuel
  ['fuel', 'lpg-cylinder', 'LPG cylinder', 'nos', true, /petroleum gas|\blpg\b|cylinder/, true],
  ['fuel', 'diesel', 'Diesel', 'ltr', true, /diesel/],
  ['fuel', 'coal', 'Coal', 'kg', true, /\bcoal\b/],
  ['fuel', 'gas-plant-installation', 'Gas plant / vaporizer installation', null, false, /vaporizer|gas train|manifold header/],
  // ---- electrical
  ['electrical', 'dg-hire', 'DG / generator hire', 'day', true, /\bdg\b|generator/, true],
  ['electrical', 'power-supply-rental', 'HT/LT power supply & transformer rental', null, false, /transformer|power supply|energy deposit|power cable supply|load extension|metering cubical|rmu/],
  ['electrical', 'wiring-works', 'Electrical wiring works (lump sum)', null, false, /cabling|cablling|wiring|light work|electrical fitting|electrical testing|electric labour/],
  ['electrical', 'ht-cable-joint', 'HT cable joint / termination', 'nos', true, /xlpe hs|termination|straight joint/, true],
  ['electrical', 'ht-lt-power-cable', 'HT/LT aluminium power cable', 'mtr', true, /xlpe|aluminum cable|alu .*cable|aluminium cable|unarmour/, true],
  ['electrical', 'cable-tie', 'Cable tie', 'pcs', true, /cable tie/, true],
  ['electrical', 'cable-laying', 'Cable laying (labour)', 'mtr', false, /cable laying|cable slitting/],
  ['electrical', 'copper-flex-cable', 'Copper flexible cable / wire', 'mtr', true, /cu flexi|flexi|cabal|cable copper|^(?!.*(hdmi|speaker|usb))(?=.*\bcable\b)|\bwire\b(?! nail)|core flat|^c$|sqmm|^sq c$|lugs/, true],
  ['electrical', 'mcb-switchgear', 'MCB / switchgear', 'nos', true, /\bmcb\b|\bacb\b|dpo switch|\belr\b|chaug over|change ?over|gland|earth plate/, true],
  ['electrical', 'switch-socket', 'Switch / socket / plug point', 'nos', true, /\bswitch\b(?! (poe|giga|rent|port))|socket|soket|plug|pluge/, true],
  ['electrical', 'panel-board', 'Panel / distribution board', 'nos', true, /panal|panel|penal|power board|surface box|\bboard\b(?! fit)/],
  ['electrical', 'led-light', 'LED light / bulb / tube', 'nos', true, /\bled\b(?! (screen|logo))|light|highbay|\bbulb\b|tube light|\bholder\b|\blamps?\b/, true],
  ['electrical', 'electrical-other', 'Other electrical items', null, false, /capacitor|stabilizer|conduit|electric/],
  // ---- AC
  ['ac', 'ac-unit-hire-supply', 'AC unit (hire / supply)', 'ton', true, /air ?condition|aircondis|split ac|\bac\b(?! (ke|machine installation|sater))|ductable|inverter|carrier/, true],
  ['ac', 'ac-installation', 'AC installation / accessories', null, false, /a c machine|ac sater|outdoor unit/],
  ['ac', 'fan-ventilation', 'Fan / exhaust / ventilation', 'nos', true, /\bfans?\b|exhaust|hvsl|ducting|blower/],
  ['ac', 'chilling-plant', 'Chilling plant hire', 'day', true, /chilling plant/],
  // ---- plumbing handled by plumbing() below; these are the non-fitting ones
  ['plumbing', 'boring-works', 'Borewell drilling', 'ft', true, /boring drilling|boaring|digging the pit/],
  ['plumbing', 'boring-pipe', 'Borewell PVC pipe', 'ft', true, /boring pvc|column pipe/, true],
  ['plumbing', 'pump-set', 'Pump set (submersible / booster)', 'nos', true, /submersible|pump set|pressure pump|booster pump/, true],
  ['plumbing', 'ro-plant', 'RO water plant', 'nos', true, /\bro water plant|\br o installing/, true],
  ['plumbing', 'water-tank', 'Water tank', 'nos', true, /water tank|sintex/, true],
  ['plumbing', 'sanitary-fixture', 'Sanitary fixture (basin / tap / shower / flush)', 'nos', true, /basin(?! counter)|flush|toilet|washroom|shower|sawar|nozal|bib cock|angle cock|stop cock|finish cock|geyser|gizar|jet spa?ry|soap dish|\btap\b|sink/],
  ['plumbing', 'pipe-solvent', 'Solvent cement / solution', 'pcs', true, /solvent|solven|solution|\bglue\b/, true],
  ['plumbing', 'teflon-tape', 'Teflon tape', 'pcs', true, /tef+lon/],
  ['plumbing', 'plumbing-works', 'Plumbing / pipeline works (lump sum)', null, false, /pipeline|plumbing|refitting|drainage/],
  // ---- civil / steel / carpentry
  ['civil', 'ms-pipe-section', 'MS pipe / hollow section', 'kg', true, /\bm ?s pipe|ms erw|rhs|shs|m s pipes/, true],
  ['civil', 'ms-sheet-coil', 'MS / GP / GC sheet & coil', 'kg', true, /gp coil|gc sheet|ppgl|m s sheet|\bss .*sheet/],
  ['civil', 'ms-fabrication', 'MS fabrication (lump sum)', null, false, /fabrication|i beam|channel|\bangle\b|\bshed\b|m s buk/],
  ['civil', 'cement-sand-masonry', 'Cement / masonry / plaster', null, false, /cement|cemenat|pcc|bricks|plaster|masonry|demoli/],
  ['civil', 'tiles', 'Tiles', 'sqft', true, /tiles/],
  ['civil', 'paint-distemper', 'Paint / distemper', 'sqft', true, /paint|distemper/],
  ['civil', 'rcc-cover', 'RCC cover', 'nos', true, /rcc cover/, true],
  ['civil', 'plywood', 'Plywood / MDF / ACP sheet', 'sqft', true, /\bply\b|plywood|mdf|acp sheet|aluminium composite|laminate|sunpack/],
  ['civil', 'carpentry-works', 'Carpentry / civil works (lump sum)', null, false, /ply cutting|cutting ply|carpenter|floor work|wall kitchen work|other work|glass(es)? .*fixing|glass hole|mirror/],
  ['civil', 'hardware', 'Hardware (screws, bolts, hinges, locks)', 'pcs', true, /screw|bolt|hinges|aldrop|haldrop|lock|washer\b|nail|chain|khila|khili|closer|clip\b/, true],
  ['civil', 'tools', 'Tools', 'nos', true, /hammer|pliers|drill|spatula|pressure washer|chisel|snap cutter|spanner|scissor|cutting wheel|knife stone/],
  ['civil', 'tape-rope-tarpaulin', 'Tape / rope / tarpaulin / foam', null, true, /tape|rope|tarpaulin|tarpauline|foam|epe|polygrip|silicon gan|bond|fevicol|araldite|laching belt|net rol/],
  ['civil', 'safety-wear', 'Safety wear (shoes, gumboots, raincoats, gloves)', 'nos', true, /safety shoes|gumboots|raincoat|gloves|apron|lungmask/, true],
  // ---- housekeeping / disposables
  ['housekeeping', 'cleaning-chemicals', 'Cleaning chemicals (phenyl, dishwash, handwash)', 'ltr', true, /phenyl|phynel|cleaner|dishwash|hand ?wash|lubricant|heatx|odonil|bathrom/, true],
  ['housekeeping', 'cleaning-tools', 'Brooms, mops, brushes, wipers', 'pcs', true, /broom|mop\b|swash card|smash card|brush|wiper|dust pan|scrub|cotton chindi/],
  ['housekeeping', 'food-containers', 'Food containers / bowls / plates', 'pcs', true, /container|bowl|paper cup|paper cover|tea glass|spoon|\bcont\b|plate|baggage|scoop|bucket|crate|jar|bottle|tola crystal|tray/, true],
  ['housekeeping', 'bags-polythene', 'Bags / polythene / garbage bags', 'kg', true, /\bbag\b|polythene|garbage|zip lock|safra/],
  ['housekeeping', 'textiles', 'Mattress / pillows / fabric / T-shirts', 'nos', true, /mattress|pillow|fabric|tshirts?|cloth hanger|towel|cotton/],
  ['housekeeping', 'bukhoor-ittar', 'Bukhoor / oudh', 'nos', true, /bukhoor|bakhoor|oud/],
  // ---- AV / media / office
  ['office', 'led-screen-rental', 'LED screen rental', 'sqft', true, /led screen|p screens?\b|screens with technicians/],
  ['office', 'sound-system', 'Sound system / mic / amplifier', 'nos', true, /speakers?|\bmi(ke|c)\b|sound|audio|amplifier|\bamp\b|mixer ch|di box/],
  ['office', 'photography-video', 'Photography / video', null, false, /photo|video|camera|cinematography/],
  ['office', 'it-network', 'Network (fiber, switch, Wi-Fi)', 'nos', true, /fiber|patch cord|media converter|access point|\bnvr\b|cat box|poe|giga|wifi|data socla|router|tp link/],
  ['office', 'it-hardware', 'Computers, printers & accessories', 'nos', true, /cpu|printer|cable creation|computer(?! table)|hdd|\bssd\b|laptop|webcam|hdmi|usb|tripod/],
  ['office', 'printer-consumables', 'Ink / toner / plotter roll', 'nos', true, /\bink\b|cartridge|toner|plotter|ploter|canvas matt/],
  ['office', 'printing-signage', 'Printing / banner / signage / stickers', 'sqft', true, /banner|flex|print|signboard|sticker|vinyl|flag|led logo|standee|card\b/],
  ['office', 'telecom', 'Mobile recharge / SMS / STB', null, false, /recharge|\bsms\b|stb charge/],
  ['office', 'stationery', 'Stationery', 'pcs', true, /stationary|stationery|paper|pen\b|pencil|marker|file\b|stapler|punch|calculator|voucher|challan|envelope|sticky notes|register|box file/],
  ['office', 'furniture', 'Furniture & racks', 'nos', true, /chair|table|rack|bed\b|stand\b|counter|stool|cupboard/],
  // ---- food
  ['food', 'goat-zabihat', 'Goat / zabihat', 'nos', true, /zabihat|bakra/],
  ['food', 'meat-offal', 'Meat / offal', 'kg', true, /mundi|kaleji|gurda|paya|chicken|mutton|murgo/],
  ['food', 'chhas-buttermilk', 'Chhas / buttermilk', 'ltr', true, /chhas/, true],
  ['food', 'milk', 'Milk', 'ltr', true, /\bmilk\b(?! powder)/, true],
  ['food', 'milk-powder-creamer', 'Milk powder / creamer', 'kg', true, /milk powder|creamer/, true],
  ['food', 'dahi-curd', 'Dahi / curd', 'kg', true, /dahi/, true],
  ['food', 'butter', 'Butter', 'kg', true, /butter/, true],
  ['food', 'cheese', 'Cheese', 'kg', true, /cheese/, true],
  ['food', 'fresh-cream', 'Fresh cream', 'ltr', true, /cream/, true],
  ['food', 'paneer-ghee', 'Paneer / ghee', 'kg', true, /paneer|ghee/, true],
  ['food', 'cardamom', 'Elaichi (cardamom)', 'kg', true, /elaichi|eluchi/],
  ['food', 'chilli-powder', 'Chilli powder (marchu)', 'kg', true, /marchu|mirchi powder|chilli powder|kashmiri m/],
  ['food', 'coriander', 'Dhana (coriander)', 'kg', true, /dhana|dhani/],
  ['food', 'turmeric', 'Haldi (turmeric)', 'kg', true, /haldi/],
  ['food', 'spices-other', 'Other spices & masala', 'kg', false, /powder|methi|dalchini|jeera|masala|salt|namak|kesar|mari |badiyan|variyari|rokam|shateera|ajwain|clove|laung/],
  ['food', 'dry-fruit', 'Dry fruit & nuts', 'kg', true, /almond|pista|kaju|kismis|anjeer|figs|khajoor|dates|walnut|kesar pista/],
  ['food', 'sauces-condiments', 'Sauces & condiments', 'pcs', true, /sauce|vinegar|ketchup/, true],
  ['food', 'edible-oil', 'Edible oil', 'ltr', true, /\boil\b(?! paint)/, true],
  ['food', 'vegetables', 'Vegetables', 'kg', true, /peas|ginger|adrak|garlic|lasan|fenugreek|limbu|kokam|marcha|piyaz|kothmir|kadi patta|fudino|broccoli|tameta|tomato\b|potato|onion|corn|vegetable|chaya/],
  ['food', 'fruit', 'Fruit', 'kg', true, /grapes|mandarin|apple|banana|mango(?! milk)/],
  ['food', 'pasta-noodles', 'Pasta / noodles', 'kg', true, /pasta|spaghetti|macroni|noodles|penne/, true],
  ['food', 'bakery-snacks', 'Bread / pav / snacks / sweets', null, false, /bread|biscuits?|pav\b|pavbhaji|pav bhaji|khaman|snacks|bhel|chocolate|sweet|refreshment|breakfast|food hamper|biryani/],
  ['food', 'beverages', 'Tea / soda / beverages', null, true, /\btea\b(?! (jar|glass))|soda|honey|coffee|juice|water bottle/],
  ['food', 'grocery-other', 'Other grocery', null, false, /\batta\b|chalni|maida|rava|sugar|rice|\bdal\b|flour/],
  // ---- misc / fees
  ['misc', 'accommodation', 'Accommodation / property rent', null, false, /\brooms?\b|property|mansion|palace|roomtariff|booking|flat\b/],
  ['misc', 'pallets', 'Pallets', 'nos', true, /pallet/],
  ['misc', 'consultancy-training', 'Consultancy / training / audit', null, false, /consultancy|training|auditor|drawing work|autocad|notary/],
  ['misc', 'fees-charges', 'Fees, deposits & misc charges', null, false, /charges?\b|deposit|inspection|retail|report|fees?\b|rent\b|rental|hire\b|installation|repair/],
];

// ---- plumbing pipes and fittings: material + type
const MATERIAL = [
  ['cpvc', /astral|asral|aasral|asrl|\bc ?pvc\b|cpvc/],
  ['swr', /\bsup\b|trap sup|bfouler/],
  ['gi', /\bg ?i\b|gi\b/],
  ['hdpe', /hdpe/],
  ['copper', /copper/],
  ['pvc', /\bpvc\b|upvc/],
];
const FITTING = [
  ['brass-adaptor', 'brass-insert fitting (MABT/FABT/brass elbow)', /bras+ (mabt|fabt|nart|fast|elbow)|br t (mapt|fapt)|\bmabt\b|\bfabt\b|bra elbow/],
  ['reducer', 'reducer / reducing bush', /r ?bus|r ?using|red ?bus|reducer|red bushing|r busing|\bri soc\b|\brl soc\b/],
  ['reducing-tee', 'reducing tee', /r ?tee|red tee|t tee/],
  ['elbow', 'elbow / bend', /elbow|bend|el\b/],
  ['tee', 'tee', /\btee\b|cross tee/],
  ['coupler', 'coupler / socket', /coupl|copling|couplin|\bsoc\b|socket/],
  ['adaptor', 'threaded adaptor (MAPT/FAPT)', /\bmapt\b|\bfapt\b|\bfap\b|\bmap\b|adaptor/],
  ['end-cap', 'end cap', /\bcap\b/],
  ['nipple', 'nipple', /nipp?l?e?\b|\bnip\b|nij|hipp/],
  ['union', 'union', /union/],
  ['clamp', 'pipe clamp', /clamp/],
  ['p-trap', 'P-trap', /trap/],
  ['ball-valve', 'ball valve', /ball val|ball valve|\bval\b|aval val/],
  ['non-return-valve', 'non-return valve (NRV)', /\bnrv\b|non ret|not valve/],
  ['flange', 'flange', /flange/],
  ['strainer', 'strainer', /strainer/],
  ['pipe', 'pipe', /\bpipe\b/],
];
const MAT_LABEL = { cpvc: 'CPVC', swr: 'SWR (Supreme)', gi: 'GI', hdpe: 'HDPE', copper: 'Copper', pvc: 'PVC' };

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[0-9]+(\.[0-9]+)?\s*(mm|cm|inch|in|ft|feet|kg|kgs|gm|g|ltr|l|m|mtr|sqft|nos|no|pcs|hp|w|v|"|'|x)?\b/g, ' ')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function plumbing(n) {
  for (const [type, label, re] of FITTING) {
    if (!re.test(n)) continue;
    let mat = null;
    for (const [m, mre] of MATERIAL) if (mre.test(n)) { mat = m; break; }
    if (type === 'pipe' && !mat) return null; // "pipe" alone isn't enough (ms pipe etc. handled elsewhere)
    if (type === 'pipe' && /\bm ?s\b|ms\b|petrol|hose|aluminum|ss pipe|basin|sanitary|structure/.test(n)) return null;
    const m = mat || (type === 'ball-valve' || type === 'non-return-valve' || type === 'flange' || type === 'strainer' ? 'any' : null);
    if (!m) return null;
    const key = m === 'any' ? type : `${m}-${type}`;
    const lab = m === 'any' ? label[0].toUpperCase() + label.slice(1) : `${MAT_LABEL[m]} ${label}`;
    const unit = type === 'pipe' ? 'mtr' : 'pcs';
    return ['plumbing', key, lab, unit, true, null, true];
  }
  return null;
}

function classify(raw) {
  const n = norm(raw);
  if (!n) return null;
  // plumbing fittings take precedence only when a material/fitting word is present and it isn't
  // obviously another family (boring pipe, solvent, valves with cocks)
  if (!/boring|column pipe|solvent|solven|solution|teflon|pipeline|fabrication|ink|cartridge|chilli|marcha|velvet|towel|stand|structure|for ac\b|w door/.test(n)) {
    const p = plumbing(n);
    if (p) return p;
  }
  for (const f of F) if (f[5].test(n)) return f;
  return null;
}

// ---- size reader: returns {spec, label} or null
const frac = s => {
  // "1.1/2" "1 1/2" "1+1/2" "1/2" "2" "2.5"
  s = s.trim();
  let m = s.match(/^(\d+)[ .+-](\d)\/(\d)$/); if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d)\/(\d)$/); if (m) return m[1] / m[2];
  m = s.match(/^\d+(\.\d+)?$/); if (m) return +s;
  return null;
};
const INCH = String.raw`(\d+[ .+-]\d\/\d|\d\/\d|\d+(?:\.\d+)?)`;
function readSize(raw, fam) {
  let sdr = null;
  const s = (raw || '').toLowerCase().replace(/\s+/g, ' ').replace(/sdr\s*(\d+)/, (m, d) => { sdr = +d; return ' '; });
  const spec = {};
  let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s?mm|sqmm|mm2|sq)?\s*[x*]\s*(\d+(?:\.\d+)?)\s*c\b/)) || (m = s.match(/(\d+(?:\.\d+)?)\s*c\s*x\s*(\d+(?:\.\d+)?)/))) {
    // cable: "2.5*3c" -> 2.5 sqmm, 3 core ; "4cx 95 sqmm" -> handled by second form (cores first)
    if (/^\d+(\.\d+)?\s*c\s*x/.test(m[0])) { spec.cores = +m[1]; spec.sqmm = +m[2]; } else { spec.sqmm = +m[1]; spec.cores = +m[2]; }
  } else if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s?mm|sqmm|mm2)/))) spec.sqmm = +m[1];
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*kva/))) spec.kva = +m[1];
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*hp\b/))) spec.hp = +m[1];
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*tr?(?:on)?s?\b(?=.*(ac|inverter|split|carrier))/)) && /ton|tr\b/.test(m[0])) spec.ton = +m[1];
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:watt|w)\b(?!\s*\/)/))) spec.watt = +m[1];
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:ml)\b/))) spec.pack_ml = +m[1];
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:ltrs?|lts?|l|liter|litre)\b/))) spec.pack_ltr = +m[1];
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*kgs?\b/)) && !/pipe/.test(fam)) spec.pack_kg = +m[1];
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:gm|g|grams?)\b/))) spec.pack_g = +m[1];
  if ((m = s.match(/(\d+)\s*amp?\b/))) spec.amp = +m[1];
  if ((m = s.match(/(\d+)\s*(?:p|pole)\b/)) && /mcb/.test(s)) spec.poles = +m[1];
  // pipe/fitting diameters
  if (/^(cpvc|pvc|gi|swr|hdpe)-|^copper-pipe$|^ball-valve$|^non-return|^flange$|^boring-pipe$|^ms-pipe/.test(fam)) {
    if ((m = s.match(/(\d+)\s*mm\s*[x*]\s*(\d+)/)) || (m = s.match(/(\d+)\s*[x*]\s*(\d+)(?!\s*(?:ft|'|"))/)) && fam.startsWith('swr')) { spec.dia_mm = [+m[1], +m[2]]; }
    else if ((m = s.match(/(\d+)\s*mm/))) spec.dia_mm = +m[1];
    else {
      // inch sizes, possibly two (reducers): tokens separated by * x + " or space
      const toks = [...s.matchAll(new RegExp(INCH + String.raw`\s*("|'|inch)?`, 'g'))]
        .filter(t => !/kg|ft|mtr|isi/.test(s.slice(t.index + t[0].length, t.index + t[0].length + 4)))
        .map(t => frac(t[1])).filter(v => v != null && v > 0 && v <= 12);
      const two = /reducer|reducing|brass-adaptor/.test(fam);
      if (toks.length === 1) spec.dia_in = toks[0];
      else if (toks.length >= 2 && two) spec.dia_in = [toks[0], toks[1]];
      else if (toks.length === 2 && /nipple/.test(fam)) { spec.dia_in = toks[0]; spec.length_in = toks[1]; }
      else if (toks.length === 2 && toks[1] < 1 && toks[0] >= 1 && Number.isInteger(toks[0])) spec.dia_in = toks[0] + toks[1]; // 1"1/2 -> 1.5
      else if (toks.length >= 2) spec.ambiguous = s.match(/[\d.\/"'*+ ]{3,}/)?.[0]?.trim();
    }
    if ((m = s.match(/(\d+)\s*kg\b/))) spec.pressure_kg = +m[1];
    if (sdr) spec.sdr = sdr;
    if ((m = s.match(/(\d+)\s*(?:ft|')\b/)) && /pipe/.test(fam)) spec.length_ft = +m[1];
  }
  if (Object.keys(spec).length === 0) return null;
  const fmt = v => Array.isArray(v) ? v.map(fmt).join('x') : String(+(+v).toFixed(3));
  const label = Object.entries(spec).map(([k, v]) => k === 'ambiguous' ? `?(${v})` :
    k === 'dia_in' ? fmt(v) + 'in' : k === 'dia_mm' ? fmt(v) + 'mm' : `${fmt(v)}${k.replace(/^pack_/, '').replace('length_in', 'in-long').replace('length_ft', 'ft').replace('pressure_kg', 'kg').replace('dia_', '')}`).join('-');
  return { spec, label };
}

export { CATS, F, classify, readSize, norm };
