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
  real_estate_property_sales: "service",
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
