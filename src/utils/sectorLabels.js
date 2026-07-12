// Mirrors the `value -> label` pairs of the frontend's sector taxonomy
// (velte/src/lib/sectors.ts, SECTOR_TAXONOMY). Signup's `sector` field stores
// the slug (e.g. "phones_accessories"); the Store's `sectors` field is meant
// to hold display labels (e.g. "Phones & Accessories") — the vendor-facing
// Store editor only highlights a chip when it matches a label, so seeding a
// raw slug in there silently shows as "nothing selected". Keep this in sync
// by hand if the frontend taxonomy changes.
export const SECTOR_LABEL_BY_VALUE = {
  restaurants_quick_service: "Restaurants & Quick Service",
  catering_event_food: "Catering & Event Food",
  bakery_pastries: "Bakery & Pastries",
  bars_lounges_nightlife: "Bars, Lounges & Nightlife",
  street_food_local_delicacies: "Street Food & Local Delicacies",
  confectionery_snacks: "Confectionery & Snacks",
  hotels_shortlets: "Hotels & Short-lets",
  event_planning_services: "Event Planning Services",

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
  hairdressing_barbing: "Hairdressing & Barbing",
  makeup_artistry: "Makeup Artistry",
  spa_massage: "Spa & Massage",
  nail_care: "Nail Care",
  perfumes_fragrances: "Perfumes & Fragrances",

  pharmacy_medicines: "Pharmacy & Medicines",
  medical_equipment_supplies: "Medical Equipment & Supplies",
  clinics_hospitals: "Clinics & Hospitals",
  dental_services: "Dental Services",
  diagnostic_lab_services: "Diagnostic & Lab Services",
  fitness_gyms: "Fitness & Gyms",
  nutrition_dietetics: "Nutrition & Dietetics",
  traditional_herbal_medicine: "Traditional & Herbal Medicine",

  furniture: "Furniture",
  home_decor_furnishings: "Home Decor & Furnishings",
  kitchenware_appliances: "Kitchenware & Appliances",
  bedding_linens: "Bedding & Linens",
  interior_design_services: "Interior Design Services",

  building_materials: "Building Materials",
  hardware_tools: "Hardware & Tools",
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

  generator_solar_install_repair: "Generator & Solar Installation/Repair",
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
  educational_materials: "Educational Materials & Publishing",

  crop_farming_produce: "Crop Farming & Produce Sales",
  livestock_poultry: "Livestock & Poultry",
  fishery_aquaculture: "Fishery & Aquaculture",
  agro_processing: "Agro-processing (Milling, Packaging)",
  farm_inputs_equipment: "Farm Inputs & Equipment",
  agricultural_consulting: "Agricultural Consulting Services",

  logistics_courier_services: "Logistics & Courier Services",
  ride_hailing_car_hire: "Ride-hailing & Car Hire",
  haulage_trucking: "Haulage & Trucking",
  moving_relocation_services: "Moving & Relocation Services",
  freight_forwarding_clearing: "Freight Forwarding & Clearing",

  microfinance_loans: "Microfinance & Loans",
  insurance_services: "Insurance Services",
  bureau_de_change_forex: "Bureau de Change / Forex",
  investment_wealth_advisory: "Investment & Wealth Advisory",
  cooperative_societies: "Cooperative Societies",

  music_audio_production: "Music & Audio Production",
  film_video_production: "Film & Video Production",
  event_centers_rentals: "Event Centers & Rentals",
  dj_mc_services: "DJ & MC Services",
  art_craft_sales: "Art & Craft Sales",
  content_creation_influencer: "Content Creation & Influencer Services",

  food_beverage_manufacturing: "Food & Beverage Manufacturing",
  textile_manufacturing: "Textile Manufacturing",
  furniture_manufacturing: "Furniture Manufacturing",
  plastics_packaging_manufacturing: "Plastics & Packaging Manufacturing",
  cosmetics_manufacturing: "Cosmetics Manufacturing",

  cleaning_services: "Cleaning Services",
  laundry_dry_cleaning: "Laundry & Dry Cleaning",
  fumigation_pest_control: "Fumigation & Pest Control",
  domestic_staffing: "Domestic Staffing (Nanny, Cook, etc.)",
  gardening_landscaping: "Gardening & Landscaping",
  security_services: "Security Services",

  religious_organizations: "Religious Organizations & Ministries",
  ngos_nonprofits: "NGOs & Nonprofits",
  community_associations: "Community Associations",

  import_export_trading: "Import & Export Trading",
  government_public_sector_contracting:
    "Government & Public Sector Contracting",
  other: "Other",
};

/** Converts a signup sector slug to its display label; passes unknown values through as-is. */
export function sectorLabel(value) {
  if (!value) return value;
  return SECTOR_LABEL_BY_VALUE[value] || value;
}

// Mirrors each leaf's own `classification` from the frontend taxonomy — needed
// to recompute a vendor's overall businessType from their full Store.sectors
// list (a vendor isn't locked to the single classification derived from their
// signup sector; adding a service sector later should unlock service listing
// blocks too). Keep in sync by hand alongside SECTOR_LABEL_BY_VALUE above.
export const SECTOR_CLASSIFICATION_BY_LABEL = {
  "Restaurants & Quick Service": "food",
  "Catering & Event Food": "food_both",
  "Bakery & Pastries": "food",
  "Bars, Lounges & Nightlife": "food",
  "Street Food & Local Delicacies": "food",
  "Confectionery & Snacks": "food",
  "Hotels & Short-lets": "service",
  "Event Planning Services": "service",

  "Groceries & Supermarket": "retail",
  "Provision Stores & Kiosks": "retail",
  "Wholesale & Distribution": "retail",
  "Stationery & Books": "both",
  "Toys & Kids' Items": "retail",
  "Gift Items & Souvenirs": "retail",

  "Clothing & Apparel": "retail",
  "Shoes & Footwear": "retail",
  "Bags & Accessories": "retail",
  "Jewelry & Watches": "both",
  "Tailoring & Fashion Design": "both",
  "Textile & Fabric Sales": "retail",

  "Phones & Accessories": "both",
  "Computers & Laptops": "both",
  "Home Electronics & Appliances": "both",
  "Gaming & Consoles": "retail",
  "Software Development & IT Services": "service",
  "Phone & Gadget Repairs": "service",
  "Computer Repairs & IT Support": "service",

  "Cosmetics & Skincare Retail": "retail",
  "Hairdressing & Barbing": "both",
  "Makeup Artistry": "service",
  "Spa & Massage": "service",
  "Nail Care": "service",
  "Perfumes & Fragrances": "retail",

  "Pharmacy & Medicines": "both",
  "Medical Equipment & Supplies": "retail",
  "Clinics & Hospitals": "service",
  "Dental Services": "service",
  "Diagnostic & Lab Services": "service",
  "Fitness & Gyms": "service",
  "Nutrition & Dietetics": "service",
  "Traditional & Herbal Medicine": "both",

  Furniture: "both",
  "Home Decor & Furnishings": "retail",
  "Kitchenware & Appliances": "retail",
  "Bedding & Linens": "retail",
  "Interior Design Services": "service",

  "Building Materials": "retail",
  "Hardware & Tools": "retail",
  "Construction & Contracting": "service",
  "Architecture & Engineering Design": "service",
  "Plumbing Services": "service",
  "Electrical Installation Services": "service",
  "Painting & Decorating Services": "service",
  "Real Estate & Property Sales": "service",
  "Property Management": "service",

  "Auto Parts & Accessories": "both",
  "Vehicle Sales": "retail",
  "Auto Repair & Mechanic Services": "service",
  "Car Wash & Detailing": "service",
  "Tyre Sales & Vulcanizing": "both",
  "Motorcycle & Tricycle (Keke) Sales": "retail",

  "Generator & Solar Installation/Repair": "both",
  "Appliance Repair": "service",
  "Shoe & Bag Repair (Cobbling)": "service",
  "Watch Repair": "service",

  "Consulting & Advisory": "service",
  "Accounting & Bookkeeping": "service",
  "Legal Services": "service",
  "Marketing & Advertising": "service",
  "Graphic Design & Branding": "service",
  "Photography & Videography": "service",
  "Printing & Publishing": "service",
  "Recruitment & HR Services": "service",
  "Translation & Interpretation": "service",
  "Virtual Assistance & Admin Support": "service",

  "Schools & Tutorial Centers": "service",
  "Vocational & Skills Training": "service",
  "Online Courses & E-learning": "service",
  "Daycare & Creche": "service",
  "Educational Materials & Publishing": "retail",

  "Crop Farming & Produce Sales": "retail",
  "Livestock & Poultry": "retail",
  "Fishery & Aquaculture": "retail",
  "Agro-processing (Milling, Packaging)": "both",
  "Farm Inputs & Equipment": "retail",
  "Agricultural Consulting Services": "service",

  "Logistics & Courier Services": "service",
  "Ride-hailing & Car Hire": "service",
  "Haulage & Trucking": "service",
  "Moving & Relocation Services": "service",
  "Freight Forwarding & Clearing": "service",

  "Microfinance & Loans": "service",
  "Insurance Services": "service",
  "Bureau de Change / Forex": "service",
  "Investment & Wealth Advisory": "service",
  "Cooperative Societies": "service",

  "Music & Audio Production": "service",
  "Film & Video Production": "service",
  "Event Centers & Rentals": "service",
  "DJ & MC Services": "service",
  "Art & Craft Sales": "both",
  "Content Creation & Influencer Services": "service",

  "Food & Beverage Manufacturing": "food",
  "Textile Manufacturing": "retail",
  "Furniture Manufacturing": "both",
  "Plastics & Packaging Manufacturing": "retail",
  "Cosmetics Manufacturing": "retail",

  "Cleaning Services": "service",
  "Laundry & Dry Cleaning": "service",
  "Fumigation & Pest Control": "service",
  "Domestic Staffing (Nanny, Cook, etc.)": "service",
  "Gardening & Landscaping": "service",
  "Security Services": "service",

  "Religious Organizations & Ministries": "service",
  "NGOs & Nonprofits": "service",
  "Community Associations": "service",

  "Import & Export Trading": "retail",
  "Government & Public Sector Contracting": "service",
  Other: "both",
};

/**
 * Merges the classifications of a Store's current sectors into one overall
 * businessType. Returns null when nothing recognized is selected — callers
 * should leave the existing businessType untouched in that case rather than
 * overwrite it with a guess.
 */
export function mergeBusinessType(sectorLabels) {
  const classifications = (sectorLabels || [])
    .map((label) => SECTOR_CLASSIFICATION_BY_LABEL[label])
    .filter(Boolean);
  if (classifications.length === 0) return null;

  const hasFood = classifications.some((c) => c === "food" || c === "food_both");
  const hasService = classifications.some(
    (c) => c === "service" || c === "both" || c === "food_both",
  );
  const hasRetail = classifications.some((c) => c === "retail" || c === "both");

  if (hasFood) return hasService ? "food_both" : "food";
  if (hasRetail && hasService) return "both";
  if (hasService) return "service";
  return "retail";
}
