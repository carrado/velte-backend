// Mirrors the frontend's sector taxonomy (velte/src/lib/sectors.ts,
// SECTOR_TAXONOMY) — the Enugu-pilot-scoped list, not the full canonical
// taxonomy. `User.sectors` / a listing's `sectorValue` store slugs (e.g.
// "phones_accessories"); `Store.sectors` stores display LABELS (e.g.
// "Phones & Accessories") since that's what feeds the AI embedding text and
// what the Store editor's chip UI matches against. Keep both maps in sync by
// hand if the frontend taxonomy changes — there is no shared source of truth
// between the two repos.
export const SECTOR_LABEL_BY_VALUE = {
  restaurants_quick_service: "Restaurants & Quick Service",
  catering_event_food: "Catering & Event Food",
  bakery_pastries: "Bakery & Pastries",
  bars_lounges_nightlife: "Bars, Lounges & Nightlife",
  street_food_local_delicacies: "Street Food & Local Delicacies",
  confectionery_snacks: "Confectionery & Snacks",
  hotels_shortlets: "Hotels & Short-lets",

  event_planning_services: "Event Planning Services",
  ushering_services: "Ushering Services",

  groceries_supermarket: "Groceries & Supermarket",
  provision_stores_kiosks: "Provision Stores & Kiosks",
  wholesale_distribution: "Wholesale & Distribution",
  stationery_books: "Stationery & Books",
  toys_kids_items: "Toys & Kids' Items",
  gift_items_souvenirs: "Gift Items & Souvenirs",

  clothing_apparel: "Clothing & Apparel",
  shoes_footwear: "Shoes & Footwear",
  bags_accessories: "Bags & Accessories",
  jewelry_watches: "Jewelry & Watches",
  tailoring_fashion_design: "Tailoring & Fashion Design",
  textile_fabric_sales: "Textile & Fabric Sales",

  phones_accessories: "Phones & Accessories",
  computers_laptops: "Computers & Laptops",
  home_electronics_appliances: "Home Electronics & Appliances",
  gaming_consoles: "Gaming & Consoles",
  software_development_it: "Software Development & IT Services",
  phone_gadget_repairs: "Phone & Gadget Repairs",
  computer_repairs_it_support: "Computer Repairs & IT Support",

  cosmetics_skincare_retail: "Cosmetics & Skincare Retail",
  makeup_artistry: "Makeup Artistry",
  spa_massage: "Spa & Massage",
  nail_care: "Nail Care",
  barbing_hair_styling: "Barbing & Hair Styling",
  perfumes_fragrances: "Perfumes & Fragrances",

  furniture: "Furniture",
  home_decor_furnishings: "Home Decor & Furnishings",
  kitchenware_appliances: "Kitchenware & Appliances",
  bedding_linens: "Bedding & Linens",
  interior_design_services: "Interior Design Services",

  construction_contracting: "Construction & Contracting",
  architecture_engineering_design: "Architecture & Engineering Design",
  plumbing_services: "Plumbing Services",
  electrical_installation_services: "Electrical Installation Services",
  painting_decorating_services: "Painting & Decorating Services",
  real_estate_property_sales: "Real Estate & Property Sales",
  property_management: "Property Management",

  auto_parts_accessories: "Auto Parts & Accessories",
  vehicle_sales: "Vehicle Sales",
  auto_repair_mechanic: "Auto Repair & Mechanic Services",
  car_wash_detailing: "Car Wash & Detailing",
  tyre_sales_vulcanizing: "Tyre Sales & Vulcanizing",
  motorcycle_keke_sales: "Motorcycle & Tricycle (Keke) Sales",

  generator_sales_repair: "Generator Sales & Repair",
  solar_installation: "Solar Panel Installation & Repair",
  appliance_repair: "Appliance Repair",
  shoe_bag_repair_cobbling: "Shoe & Bag Repair (Cobbling)",
  watch_repair: "Watch Repair",

  consulting_advisory: "Consulting & Advisory",
  accounting_bookkeeping: "Accounting & Bookkeeping",
  legal_services: "Legal Services",
  marketing_advertising: "Marketing & Advertising",
  graphic_design_branding: "Graphic Design & Branding",
  photography_videography: "Photography & Videography",
  printing_publishing: "Printing & Publishing",
  recruitment_hr_services: "Recruitment & HR Services",
  translation_interpretation: "Translation & Interpretation",
  virtual_assistance_admin: "Virtual Assistance & Admin Support",

  schools_tutorial_centers: "Schools & Tutorial Centers",
  vocational_skills_training: "Vocational & Skills Training",
  online_courses_elearning: "Online Courses & E-learning",
  daycare_creche: "Daycare & Creche",

  logistics_courier_services: "Logistics & Courier Services",
  ride_hailing_car_hire: "Ride-hailing & Car Hire",
  haulage_trucking: "Haulage & Trucking",
  moving_relocation_services: "Moving & Relocation Services",
  freight_forwarding_clearing: "Freight Forwarding & Clearing",

  music_audio_production: "Music & Audio Production",
  film_video_production: "Film & Video Production",
  content_creation_influencer: "Content Creation & Influencer Services",

  cleaning_services: "Cleaning Services",
  laundry_dry_cleaning: "Laundry & Dry Cleaning",
  fumigation_pest_control: "Fumigation & Pest Control",
  domestic_staffing: "Domestic Staffing (Nanny, Cook, etc.)",
  gardening_landscaping: "Gardening & Landscaping",
  security_services: "Security Services",
};

// Mirrors the frontend's SectorListingConfig.categoryOptional (velte/src/lib
// /sectors.ts) — sectors where no seeded retail Category ever fits a
// listing, so product/both-kind offerings skip the required category_id the
// same way services already do. Keep in sync by hand alongside the maps
// above (same no-shared-source-of-truth caveat).
export const CATEGORY_OPTIONAL_SECTOR_VALUES = new Set([
  "real_estate_property_sales",
]);

/** Converts a sector slug to its display label; passes unknown values through as-is. */
export function sectorLabel(value) {
  if (!value) return value;
  return SECTOR_LABEL_BY_VALUE[value] || value;
}

/** True if `value` is a slug in the current taxonomy — used to validate
 * signup/listing input server-side instead of trusting any string. */
export function isKnownSector(value) {
  return Object.prototype.hasOwnProperty.call(SECTOR_LABEL_BY_VALUE, value);
}

// Mirrors each leaf's own `classification` from the frontend taxonomy —
// needed to derive a listing's shape (food/retail/service tooling) from
// whichever sector it was posted under, and to merge a vendor's/store's full
// sector list into one overall businessType-shaped summary for the
// storefront/dashboard-chrome shims. Keep in sync by hand alongside
// SECTOR_LABEL_BY_VALUE above.
export const SECTOR_CLASSIFICATION_BY_VALUE = {
  restaurants_quick_service: "food",
  catering_event_food: "food_both",
  bakery_pastries: "food",
  bars_lounges_nightlife: "food",
  street_food_local_delicacies: "food",
  confectionery_snacks: "food",
  hotels_shortlets: "service",

  event_planning_services: "service",
  ushering_services: "service",

  groceries_supermarket: "retail",
  provision_stores_kiosks: "retail",
  wholesale_distribution: "retail",
  stationery_books: "both",
  toys_kids_items: "retail",
  gift_items_souvenirs: "retail",

  clothing_apparel: "retail",
  shoes_footwear: "retail",
  bags_accessories: "retail",
  jewelry_watches: "both",
  tailoring_fashion_design: "both",
  textile_fabric_sales: "retail",

  phones_accessories: "both",
  computers_laptops: "both",
  home_electronics_appliances: "both",
  gaming_consoles: "retail",
  software_development_it: "service",
  phone_gadget_repairs: "service",
  computer_repairs_it_support: "service",

  cosmetics_skincare_retail: "retail",
  makeup_artistry: "service",
  spa_massage: "service",
  nail_care: "service",
  barbing_hair_styling: "service",
  perfumes_fragrances: "retail",

  furniture: "both",
  home_decor_furnishings: "retail",
  kitchenware_appliances: "retail",
  bedding_linens: "retail",
  interior_design_services: "service",

  construction_contracting: "service",
  architecture_engineering_design: "service",
  plumbing_services: "service",
  electrical_installation_services: "service",
  painting_decorating_services: "service",
  // "both" (not "service") — mirrors frontend sectors.ts: a vendor needs to
  // list the actual property/land itself for sale/rent as a product, not
  // just offer to find/manage one as a service.
  real_estate_property_sales: "both",
  property_management: "service",

  auto_parts_accessories: "both",
  vehicle_sales: "retail",
  auto_repair_mechanic: "service",
  car_wash_detailing: "service",
  tyre_sales_vulcanizing: "both",
  motorcycle_keke_sales: "retail",

  generator_sales_repair: "both",
  solar_installation: "both",
  appliance_repair: "service",
  shoe_bag_repair_cobbling: "service",
  watch_repair: "service",

  consulting_advisory: "service",
  accounting_bookkeeping: "service",
  legal_services: "service",
  marketing_advertising: "service",
  graphic_design_branding: "service",
  photography_videography: "service",
  printing_publishing: "service",
  recruitment_hr_services: "service",
  translation_interpretation: "service",
  virtual_assistance_admin: "service",

  schools_tutorial_centers: "service",
  vocational_skills_training: "service",
  online_courses_elearning: "service",
  daycare_creche: "service",

  logistics_courier_services: "service",
  ride_hailing_car_hire: "service",
  haulage_trucking: "service",
  moving_relocation_services: "service",
  freight_forwarding_clearing: "service",

  music_audio_production: "service",
  film_video_production: "service",
  content_creation_influencer: "service",

  cleaning_services: "service",
  laundry_dry_cleaning: "service",
  fumigation_pest_control: "service",
  domestic_staffing: "service",
  gardening_landscaping: "service",
  security_services: "service",
};

/** Label-keyed mirror of the map above, purely for `Store.sectors` (which
 * stores labels) — e.g. the public-storefront businessType shim, which only
 * has labels on hand and shouldn't need a reverse slug lookup. */
const SECTOR_CLASSIFICATION_BY_LABEL = Object.fromEntries(
  Object.entries(SECTOR_LABEL_BY_VALUE).map(([value, label]) => [
    label,
    SECTOR_CLASSIFICATION_BY_VALUE[value],
  ]),
);

// Buyer-facing synonyms/Nigerian-English terms per sector, folded into
// storeEmbeddingText() (embedding.service.js) alongside a vendor's own
// bio/sector labels — attacks the exact failure mode found live with
// "Ushering Services": a vendor tagged the right sector but their own store
// description never said "ushers"/"protocol" anywhere, so a buyer searching
// those words scored too far from the embedding to match. The sector label
// alone ("Ushering Services") isn't enough either — it's the formal name,
// not how a buyer actually phrases the request. This is a first pass and
// will drift from how Nigerian buyers actually talk — review/extend rather
// than treat as final. Keep in sync by hand alongside SECTOR_LABEL_BY_VALUE
// above (same caveat as everywhere else in this file).
export const SECTOR_KEYWORDS_BY_VALUE = {
  restaurants_quick_service: "restaurant, fast food, quick service, eatery, bukka, buka, canteen, food joint, food spot, diner, cafeteria, chops",
  catering_event_food: "caterer, catering, event food, small chops, party food, cook for event, food vendor for party, jollof rice caterer, wedding caterer, party jollof, buffet",
  bakery_pastries: "bakery, baker, cake, cakes, pastries, small chops, meat pie, birthday cake, wedding cake, cupcakes, pies, doughnut, confectioner",
  bars_lounges_nightlife: "bar, lounge, club, nightlife, pub, drinks spot, beer parlour, night club, hangout spot, chill spot, cocktail bar",
  street_food_local_delicacies: "street food, local food, suya, roadside food, mama put, akara, boli, roasted corn, local delicacy, native food",
  confectionery_snacks: "snacks, confectionery, chin chin, sweets, biscuits, small chops, puff puff, plantain chips, candy, treats",
  hotels_shortlets: "hotel, shortlet, short let, guest house, lodge, apartment for rent, hotel room, event centre with rooms, guesthouse, inn, resort",

  event_planning_services: "event planner, event planning, wedding planner, party planner, decoration, event decor, event coordinator, event management, birthday planner, owanbe planner",
  ushering_services: "ushers, ushering, protocol, protocol officers, event protocol, guest management, red carpet ushers, ushering agency, wedding ushers, hostesses, event hostesses, guest reception",

  groceries_supermarket: "grocery, supermarket, mini mart, food store, mart, shopping mall, grocery store, foodstuff seller",
  provision_stores_kiosks: "provision store, kiosk, corner shop, mama put shop, mini shop, convenience store, roadside shop",
  wholesale_distribution: "wholesale, distributor, bulk supply, distribution, bulk buyer, bulk seller, wholesaler, supplier",
  stationery_books: "stationery, bookshop, books, office supplies, school supplies, exercise books, textbooks, bookstore",
  toys_kids_items: "toys, kids items, children's items, baby items, playthings, toy store, baby gear",
  gift_items_souvenirs: "gifts, souvenirs, gift shop, hampers, gift items, gift baskets, party favours, wedding souvenirs",

  clothing_apparel: "clothes, clothing, fashion, apparel, wears, outfits, boutique, ready to wear, senator wear, native wear, kaftan, agbada",
  shoes_footwear: "shoes, footwear, sneakers, sandals, slippers, palm slippers, corporate shoes, native shoes",
  bags_accessories: "bags, handbags, accessories, purses, wallets, backpacks, clutch bags, totes",
  jewelry_watches: "jewelry, jewellery, watches, gold, accessories, beads, necklace, bangles, earrings, wristwatch",
  tailoring_fashion_design: "tailor, tailoring, fashion designer, seamstress, aso ebi, sewing, ankara styles, native attire maker, dressmaker, cloth sewing, custom outfit",
  textile_fabric_sales: "fabric, textile, ankara, lace, material seller, aso ebi fabric, george fabric, adire, brocade, senator material",

  phones_accessories: "phone, phones, mobile phone, phone accessories, GSM, phone charger, phone case, earpiece, phone screen protector",
  computers_laptops: "computer, laptop, computers, PC, desktop, notebook computer",
  home_electronics_appliances: "electronics, home appliances, TV, fridge, electronics store, washing machine, home theatre, blender, microwave",
  gaming_consoles: "gaming, console, PlayStation, Xbox, video games, PS5, gamepad, gaming accessories",
  software_development_it: "software development, web developer, app developer, IT services, programmer, website, web app, mobile app, software engineer, coder, tech consultant, custom software, ecommerce website, database developer",
  phone_gadget_repairs: "phone repair, gadget repair, screen repair, fix phone, phone technician, cracked screen fix, battery replacement",
  computer_repairs_it_support: "computer repair, laptop repair, IT support, tech support, laptop technician, virus removal, data recovery",

  cosmetics_skincare_retail: "cosmetics, skincare, beauty products, makeup products, skincare products, beauty store, cream seller",
  makeup_artistry: "makeup artist, MUA, bridal makeup, makeup, glam, face beat, makeover",
  spa_massage: "spa, massage, masseuse, relaxation, wellness, body massage, spa treatment, therapy",
  nail_care: "nail tech, manicure, pedicure, nails, nail art, gel nails, acrylics",
  barbing_hair_styling: "barber, barbing salon, hairstylist, hair salon, braiding, weaving, hairdresser, wig maker, haircut, dreadlocks, cornrows, salon",
  perfumes_fragrances: "perfume, fragrance, cologne, scent, oil perfume, body spray, attar",

  furniture: "furniture, chairs, tables, sofa, furniture maker, carpenter, wardrobe, bed frame, dining set",
  home_decor_furnishings: "home decor, furnishings, interior decor, decoration items, wall art, curtains, rugs, decorative items",
  kitchenware_appliances: "kitchenware, cookware, kitchen appliances, pots, pans, cutlery, kitchen utensils",
  bedding_linens: "bedding, linens, bedsheets, duvet, pillows, mattress cover, bedspread",
  interior_design_services: "interior designer, interior design, home styling, space planning, home makeover",

  construction_contracting: "construction, contractor, builder, building contractor, mason, building construction, renovation",
  architecture_engineering_design: "architect, architecture, engineering design, building design, structural engineer, building plan, building drawing",
  plumbing_services: "plumber, plumbing, pipe repair, water leak, pipe fitting, toilet repair, water tank installation",
  electrical_installation_services: "electrician, electrical, wiring, rewiring, installation, electrical fault, generator wiring, socket repair",
  painting_decorating_services: "painter, painting, decorator, wall painting, house painting, POP design",
  real_estate_property_sales: "real estate, property, land for sale, house for sale, realtor, agent, apartment for sale, plot of land, property agent",
  property_management: "property manager, property management, facility management, landlord services, rent collection, estate management",

  auto_parts_accessories: "auto parts, car parts, spare parts, car accessories, tokunbo parts, engine parts",
  vehicle_sales: "car sales, vehicle sales, cars for sale, dealership, buy a car, tokunbo cars, used cars",
  auto_repair_mechanic: "mechanic, auto repair, car repair, panel beater, engine repair, car servicing",
  car_wash_detailing: "car wash, auto detailing, car cleaning, car wash service",
  tyre_sales_vulcanizing: "tyre, tire, vulcanizer, vulcanizing, tyre repair, tyre change, wheel balancing",
  motorcycle_keke_sales: "motorcycle, okada, keke, tricycle, bike sales, motorbike",

  generator_sales_repair: "generator, gen repair, power plant, generator technician, gen set, soundproof generator",
  solar_installation: "solar, solar panel, solar installation, inverter, solar system, battery inverter",
  appliance_repair: "appliance repair, fridge repair, AC repair, washing machine repair, air conditioner repair, freezer repair",
  shoe_bag_repair_cobbling: "cobbler, shoe repair, bag repair, cobbling, shoe mender",
  watch_repair: "watch repair, watchmaker, clock repair, watch battery replacement",

  consulting_advisory: "consultant, consulting, advisory, business advisor, strategy consultant",
  accounting_bookkeeping: "accountant, accounting, bookkeeping, tax, audit, tax filing, financial statements",
  legal_services: "lawyer, legal services, attorney, solicitor, legal advice, contract drafting",
  marketing_advertising: "marketing, advertising, ads, brand promotion, digital marketing, social media marketing, ad campaign",
  graphic_design_branding: "graphic designer, branding, logo design, flyer design, brand identity, poster design",
  photography_videography: "photographer, videographer, photography, video coverage, event coverage, wedding photographer, portrait photography",
  printing_publishing: "printing, printer, publishing, print shop, flyer printing, banner printing, business cards",
  recruitment_hr_services: "recruitment, HR, headhunting, staffing agency, job placement, talent sourcing",
  translation_interpretation: "translator, interpreter, translation services, language translation",
  virtual_assistance_admin: "virtual assistant, VA, admin support, remote assistant, executive assistant",

  schools_tutorial_centers: "school, tutorial center, lesson teacher, extra lessons, private lessons, home lessons, coaching class",
  vocational_skills_training: "vocational training, skills acquisition, trade school, skill center",
  online_courses_elearning: "online course, e-learning, online class, online training, virtual class",
  daycare_creche: "daycare, creche, childminder, babysitter, nursery",

  logistics_courier_services: "logistics, courier, delivery service, dispatch rider, package delivery, errand runner",
  ride_hailing_car_hire: "ride hailing, car hire, taxi, chauffeur, private driver, drop service, car with driver",
  haulage_trucking: "haulage, trucking, truck for hire, cargo transport, truck driver",
  moving_relocation_services: "movers, moving service, relocation, house moving, office relocation",
  freight_forwarding_clearing: "freight forwarding, customs clearing, clearing agent, shipping, import export agent",

  music_audio_production: "music producer, audio production, studio, sound engineer, DJ, beat maker, recording studio",
  film_video_production: "film production, video production, filmmaker, videographer, cinematographer",
  content_creation_influencer: "content creator, influencer, social media content, UGC, brand ambassador",

  cleaning_services: "cleaner, cleaning service, house cleaning, office cleaning, post construction cleaning",
  laundry_dry_cleaning: "laundry, dry cleaning, wash and iron, laundromat, ironing service",
  fumigation_pest_control: "fumigation, pest control, exterminator, insect control, rodent control, termite control",
  domestic_staffing: "nanny, cook, house help, domestic staff, maid, steward, housekeeper, driver for hire",
  gardening_landscaping: "gardener, landscaping, lawn care, garden maintenance, lawn mowing",
  security_services: "security guard, security services, bouncer, surveillance, CCTV installation, night guard",
};

/** Label-keyed mirror, same reasoning as SECTOR_CLASSIFICATION_BY_LABEL. */
const SECTOR_KEYWORDS_BY_LABEL = Object.fromEntries(
  Object.entries(SECTOR_LABEL_BY_VALUE).map(([value, label]) => [
    label,
    SECTOR_KEYWORDS_BY_VALUE[value],
  ]),
);

/**
 * Flattens a store's sector LABELS into one deduped keyword string for
 * embedding text — e.g. ["Ushering Services"] → "ushers, ushering,
 * protocol, ...". Unknown labels (custom/legacy) are silently skipped
 * rather than breaking embedding generation.
 */
export function sectorKeywordsForLabels(sectorLabels) {
  const seen = new Set();
  for (const label of sectorLabels || []) {
    const kw = SECTOR_KEYWORDS_BY_LABEL[label];
    if (!kw) continue;
    for (const term of kw.split(",")) seen.add(term.trim());
  }
  return [...seen].join(", ");
}

function mergeClassifications(classifications) {
  const known = classifications.filter(Boolean);
  if (known.length === 0) return null;

  const hasFood = known.some((c) => c === "food" || c === "food_both");
  const hasService = known.some(
    (c) => c === "service" || c === "both" || c === "food_both",
  );
  const hasRetail = known.some((c) => c === "retail" || c === "both");

  if (hasFood) return hasService ? "food_both" : "food";
  if (hasRetail && hasService) return "both";
  if (hasService) return "service";
  return "retail";
}

/**
 * Merges a vendor's sector SLUGS (User.sectors) into one overall
 * businessType-shaped summary — used by the dashboard-chrome shim. Returns
 * null when nothing recognized is selected.
 */
export function mergeBusinessType(sectorValues) {
  return mergeClassifications(
    (sectorValues || []).map((v) => SECTOR_CLASSIFICATION_BY_VALUE[v]),
  );
}

/**
 * Merges a store's sector LABELS (Store.sectors) into one overall
 * businessType-shaped summary — used by the public-storefront shim, which
 * only has labels on hand. Returns null when nothing recognized is selected.
 */
export function mergeBusinessTypeFromLabels(sectorLabels) {
  return mergeClassifications(
    (sectorLabels || []).map((l) => SECTOR_CLASSIFICATION_BY_LABEL[l]),
  );
}
