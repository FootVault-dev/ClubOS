// GENERATED FILE — do not edit by hand.
// Source: Sporty (NZ Football NRS) reference endpoints, environment 'uat'.
// Regenerate: npx tsx --env-file=.env script/build-nzf-vocabulary.ts
//
// This is the vocabulary NZ Football actually accepts. The registration form
// offers exactly these values, so a parent's answer is already valid at the
// point they give it — there is no mapping step left to guess wrong.
//
// 🔴 Country codes here are FIFA/IOC, NOT ISO 3166-1 alpha-3 (Samoa is SAM not
// WSM, Germany GER not DEU). Always read a code off this list.

export interface NzfCountry { code: string; name: string }
export interface NzfEthnicitySelection { id: number; name: string }
export interface NzfEthnicityGroup {
  id: number;
  name: string;
  /** Minimum specific selections the group requires. 0 = none needed. */
  minSelections: number;
  /** Maximum allowed. 0 = the group takes no selections at all. */
  maxSelections: number;
  selections: NzfEthnicitySelection[];
}

export const NZF_VOCABULARY_SOURCE = "uat" as const;
export const NZF_VOCABULARY_FETCHED_AT = "2026-07-27" as const;

export const NZF_COUNTRIES: readonly NzfCountry[] = [
  {
    "code": "AFG",
    "name": "Afghanistan"
  },
  {
    "code": "ALB",
    "name": "Albania"
  },
  {
    "code": "ALG",
    "name": "Algeria"
  },
  {
    "code": "ASA",
    "name": "American Samoa"
  },
  {
    "code": "AND",
    "name": "Andorra"
  },
  {
    "code": "ANG",
    "name": "Angola"
  },
  {
    "code": "AIA",
    "name": "Anguilla"
  },
  {
    "code": "ATA",
    "name": "Antarctica"
  },
  {
    "code": "ATG",
    "name": "Antigua and Barbuda"
  },
  {
    "code": "ARG",
    "name": "Argentina"
  },
  {
    "code": "ARM",
    "name": "Armenia"
  },
  {
    "code": "ARU",
    "name": "Aruba"
  },
  {
    "code": "AUS",
    "name": "Australia"
  },
  {
    "code": "AUT",
    "name": "Austria"
  },
  {
    "code": "AZE",
    "name": "Azerbaijan"
  },
  {
    "code": "BAH",
    "name": "Bahamas"
  },
  {
    "code": "BHR",
    "name": "Bahrein"
  },
  {
    "code": "BAN",
    "name": "Bangladesh"
  },
  {
    "code": "BRB",
    "name": "Barbados"
  },
  {
    "code": "BLR",
    "name": "Belarus"
  },
  {
    "code": "BEL",
    "name": "Belgium"
  },
  {
    "code": "BLZ",
    "name": "Belize"
  },
  {
    "code": "BEN",
    "name": "Benin"
  },
  {
    "code": "BMU",
    "name": "Bermuda"
  },
  {
    "code": "BHU",
    "name": "Bhutan"
  },
  {
    "code": "BOL",
    "name": "Bolivia"
  },
  {
    "code": "BIH",
    "name": "Bosnia and Herzegovina"
  },
  {
    "code": "BOT",
    "name": "Botswana"
  },
  {
    "code": "BVT",
    "name": "Bouvet Island"
  },
  {
    "code": "BRA",
    "name": "Brazil"
  },
  {
    "code": "IOT",
    "name": "British Indian Ocean Territory"
  },
  {
    "code": "VGB",
    "name": "British Virgin Islands"
  },
  {
    "code": "BRU",
    "name": "Brunei Darussalam"
  },
  {
    "code": "BUL",
    "name": "Bulgaria"
  },
  {
    "code": "BFA",
    "name": "Burkina Faso"
  },
  {
    "code": "BDI",
    "name": "Burundi"
  },
  {
    "code": "CAM",
    "name": "Cambodia"
  },
  {
    "code": "CMR",
    "name": "Cameroon"
  },
  {
    "code": "CAN",
    "name": "Canada"
  },
  {
    "code": "CPV",
    "name": "Cape Verde"
  },
  {
    "code": "CAY",
    "name": "Cayman Islands"
  },
  {
    "code": "CTA",
    "name": "Central African Republic"
  },
  {
    "code": "CHA",
    "name": "Chad"
  },
  {
    "code": "CHI",
    "name": "Chile"
  },
  {
    "code": "CHN",
    "name": "China"
  },
  {
    "code": "CXR",
    "name": "Christmas Island"
  },
  {
    "code": "CCK",
    "name": "Cocos"
  },
  {
    "code": "COL",
    "name": "Colombia"
  },
  {
    "code": "COM",
    "name": "Comoros"
  },
  {
    "code": "COD",
    "name": "Congo, Democratic Republic"
  },
  {
    "code": "CGO",
    "name": "Congo, Republic"
  },
  {
    "code": "COK",
    "name": "Cook Islands"
  },
  {
    "code": "CRC",
    "name": "Costa Rica"
  },
  {
    "code": "CIV",
    "name": "Cote d'Ivoire"
  },
  {
    "code": "CRO",
    "name": "Croatia"
  },
  {
    "code": "CUB",
    "name": "Cuba"
  },
  {
    "code": "CUW",
    "name": "Curaçao"
  },
  {
    "code": "CYP",
    "name": "Cyprus"
  },
  {
    "code": "CZE",
    "name": "Czech Republic"
  },
  {
    "code": "DEN",
    "name": "Denmark"
  },
  {
    "code": "DJI",
    "name": "Djibouti"
  },
  {
    "code": "DMA",
    "name": "Dominica"
  },
  {
    "code": "DOM",
    "name": "Dominican Republic"
  },
  {
    "code": "ECU",
    "name": "Ecuador"
  },
  {
    "code": "EGY",
    "name": "Egypt"
  },
  {
    "code": "SLV",
    "name": "El Salvador"
  },
  {
    "code": "ENG",
    "name": "England"
  },
  {
    "code": "EQG",
    "name": "Equatorial Guinea"
  },
  {
    "code": "ERI",
    "name": "Eritrea"
  },
  {
    "code": "EST",
    "name": "Estonia"
  },
  {
    "code": "ETH",
    "name": "Ethiopia"
  },
  {
    "code": "FLK",
    "name": "Falkland Islands"
  },
  {
    "code": "FRO",
    "name": "Faroe Islands"
  },
  {
    "code": "FIJ",
    "name": "Fiji"
  },
  {
    "code": "FIN",
    "name": "Finland"
  },
  {
    "code": "FRA",
    "name": "France"
  },
  {
    "code": "GUF",
    "name": "French Guiana"
  },
  {
    "code": "PYF",
    "name": "French Polynesia"
  },
  {
    "code": "ATF",
    "name": "French Southern Territories"
  },
  {
    "code": "GAB",
    "name": "Gabon"
  },
  {
    "code": "GAM",
    "name": "Gambia"
  },
  {
    "code": "GEO",
    "name": "Georgia"
  },
  {
    "code": "GER",
    "name": "Germany"
  },
  {
    "code": "GHA",
    "name": "Ghana"
  },
  {
    "code": "GIB",
    "name": "Gibraltar"
  },
  {
    "code": "GRE",
    "name": "Greece"
  },
  {
    "code": "GRL",
    "name": "Greenland"
  },
  {
    "code": "GRN",
    "name": "Grenada"
  },
  {
    "code": "GLP",
    "name": "Guadeloupe"
  },
  {
    "code": "GUM",
    "name": "Guam"
  },
  {
    "code": "GTM",
    "name": "Guatemala"
  },
  {
    "code": "GIN",
    "name": "Guinea"
  },
  {
    "code": "GNB",
    "name": "Guinea-Bissau"
  },
  {
    "code": "GUY",
    "name": "Guyana"
  },
  {
    "code": "HAI",
    "name": "Haiti"
  },
  {
    "code": "HMD",
    "name": "Heard and McDonald Islands"
  },
  {
    "code": "HON",
    "name": "Honduras"
  },
  {
    "code": "HKG",
    "name": "Hong Kong"
  },
  {
    "code": "HUN",
    "name": "Hungary"
  },
  {
    "code": "ISL",
    "name": "Iceland"
  },
  {
    "code": "IND",
    "name": "India"
  },
  {
    "code": "IDN",
    "name": "Indonesia"
  },
  {
    "code": "IRN",
    "name": "Iran"
  },
  {
    "code": "IRQ",
    "name": "Iraq"
  },
  {
    "code": "IRL",
    "name": "Ireland"
  },
  {
    "code": "ISR",
    "name": "Israel"
  },
  {
    "code": "ITA",
    "name": "Italy"
  },
  {
    "code": "JAM",
    "name": "Jamaica"
  },
  {
    "code": "JPN",
    "name": "Japan"
  },
  {
    "code": "JOR",
    "name": "Jordan"
  },
  {
    "code": "KAZ",
    "name": "Kazahstan"
  },
  {
    "code": "KEN",
    "name": "Kenya"
  },
  {
    "code": "KIR",
    "name": "Kiribati"
  },
  {
    "code": "KOR",
    "name": "Korea Republic"
  },
  {
    "code": "PRK",
    "name": "Korea, DPR (North)"
  },
  {
    "code": "KVX",
    "name": "Kosovo"
  },
  {
    "code": "KUW",
    "name": "Kuwait"
  },
  {
    "code": "KGZ",
    "name": "Kyrgystan"
  },
  {
    "code": "LAO",
    "name": "Laos"
  },
  {
    "code": "LVA",
    "name": "Latvia"
  },
  {
    "code": "LIB",
    "name": "Lebanon"
  },
  {
    "code": "LES",
    "name": "Lesotho"
  },
  {
    "code": "LBR",
    "name": "Liberia"
  },
  {
    "code": "LBY",
    "name": "Libya"
  },
  {
    "code": "LIE",
    "name": "Lichtenstein"
  },
  {
    "code": "LTU",
    "name": "Lithuania"
  },
  {
    "code": "LUX",
    "name": "Luxembourg"
  },
  {
    "code": "MAC",
    "name": "Macau"
  },
  {
    "code": "MKD",
    "name": "Macedonia"
  },
  {
    "code": "MDG",
    "name": "Madagascar"
  },
  {
    "code": "MWI",
    "name": "Malawi"
  },
  {
    "code": "MAS",
    "name": "Malaysia"
  },
  {
    "code": "MDV",
    "name": "Maldives"
  },
  {
    "code": "MLI",
    "name": "Mali"
  },
  {
    "code": "MLT",
    "name": "Malta"
  },
  {
    "code": "MHL",
    "name": "Marshall Islands"
  },
  {
    "code": "MTQ",
    "name": "Martinique"
  },
  {
    "code": "MTN",
    "name": "Mauritania"
  },
  {
    "code": "MRI",
    "name": "Mauritius"
  },
  {
    "code": "MZT",
    "name": "Mayotte"
  },
  {
    "code": "MEX",
    "name": "Mexico"
  },
  {
    "code": "FSM",
    "name": "Micronesia"
  },
  {
    "code": "MDA",
    "name": "Moldova"
  },
  {
    "code": "MCO",
    "name": "Monaco"
  },
  {
    "code": "MNG",
    "name": "Mongolia"
  },
  {
    "code": "MNE",
    "name": "Montenegro"
  },
  {
    "code": "MSR",
    "name": "Montserrat"
  },
  {
    "code": "MAR",
    "name": "Morocco"
  },
  {
    "code": "MOZ",
    "name": "Mozambique"
  },
  {
    "code": "MYA",
    "name": "Myanmar"
  },
  {
    "code": "NAM",
    "name": "Namibia"
  },
  {
    "code": "NRU",
    "name": "Nauru"
  },
  {
    "code": "NEP",
    "name": "Nepal"
  },
  {
    "code": "NED",
    "name": "Netherlands"
  },
  {
    "code": "ANT",
    "name": "Netherlands Antilles"
  },
  {
    "code": "NCL",
    "name": "New Caledonia"
  },
  {
    "code": "NZL",
    "name": "New Zealand"
  },
  {
    "code": "NCA",
    "name": "Nicaragua"
  },
  {
    "code": "NIG",
    "name": "Niger"
  },
  {
    "code": "NGA",
    "name": "Nigeria"
  },
  {
    "code": "NIU",
    "name": "Niue"
  },
  {
    "code": "NFK",
    "name": "Norfolk Island"
  },
  {
    "code": "NIR",
    "name": "Northern Ireland"
  },
  {
    "code": "MNP",
    "name": "Northern Mariana Islands"
  },
  {
    "code": "NOR",
    "name": "Norway"
  },
  {
    "code": "OMA",
    "name": "Oman"
  },
  {
    "code": "PAK",
    "name": "Pakistan"
  },
  {
    "code": "PLW",
    "name": "Palau"
  },
  {
    "code": "PLE",
    "name": "Palestine"
  },
  {
    "code": "PAN",
    "name": "Panama"
  },
  {
    "code": "PNG",
    "name": "Papua New Guinea"
  },
  {
    "code": "PAR",
    "name": "Paraguay"
  },
  {
    "code": "PER",
    "name": "Peru"
  },
  {
    "code": "PHL",
    "name": "Phillipines"
  },
  {
    "code": "PCN",
    "name": "Pitcairn"
  },
  {
    "code": "POL",
    "name": "Poland"
  },
  {
    "code": "POR",
    "name": "Portugal"
  },
  {
    "code": "PUR",
    "name": "Puerto Rico"
  },
  {
    "code": "QAT",
    "name": "Qatar"
  },
  {
    "code": "REU",
    "name": "Reunion"
  },
  {
    "code": "ROU",
    "name": "Romania"
  },
  {
    "code": "RUS",
    "name": "Russia"
  },
  {
    "code": "RWA",
    "name": "Rwanda"
  },
  {
    "code": "SGS",
    "name": "S. Georgia and S. Sandwich Islands"
  },
  {
    "code": "SKN",
    "name": "Saint Kitts and Nevis"
  },
  {
    "code": "LCA",
    "name": "Saint Lucia"
  },
  {
    "code": "VIN",
    "name": "Saint Vincent and the Grenadines"
  },
  {
    "code": "SAM",
    "name": "Samoa"
  },
  {
    "code": "SMR",
    "name": "San Marino"
  },
  {
    "code": "STP",
    "name": "Sao Tome and Principe"
  },
  {
    "code": "STP",
    "name": "São Tomé and Príncipe"
  },
  {
    "code": "KSA",
    "name": "Saudi Arabia"
  },
  {
    "code": "SCO",
    "name": "Scotland"
  },
  {
    "code": "SEN",
    "name": "Senegal"
  },
  {
    "code": "SRB",
    "name": "Serbia"
  },
  {
    "code": "SEY",
    "name": "Seychelles"
  },
  {
    "code": "SLE",
    "name": "Sierra Leone"
  },
  {
    "code": "SIN",
    "name": "Singapore"
  },
  {
    "code": "SVK",
    "name": "Slovakia"
  },
  {
    "code": "SVN",
    "name": "Slovenia"
  },
  {
    "code": "SOL",
    "name": "Solomon Islands"
  },
  {
    "code": "SOM",
    "name": "Somalia"
  },
  {
    "code": "RSA",
    "name": "South Africa"
  },
  {
    "code": "SSD",
    "name": "South Sudan"
  },
  {
    "code": "ESP",
    "name": "Spain"
  },
  {
    "code": "SRI",
    "name": "Sri Lanka"
  },
  {
    "code": "SHN",
    "name": "St. Helena"
  },
  {
    "code": "SPM",
    "name": "St. Pierre and Miquelon"
  },
  {
    "code": "SDN",
    "name": "Sudan"
  },
  {
    "code": "SUR",
    "name": "Suriname"
  },
  {
    "code": "SJM",
    "name": "Svalbard and Jan Mayen Islands"
  },
  {
    "code": "SWZ",
    "name": "Swaziland"
  },
  {
    "code": "SWE",
    "name": "Sweden"
  },
  {
    "code": "SUI",
    "name": "Switzerland"
  },
  {
    "code": "SYR",
    "name": "Syria"
  },
  {
    "code": "TAH",
    "name": "Tahiti"
  },
  {
    "code": "TWN",
    "name": "Taiwan"
  },
  {
    "code": "TJK",
    "name": "Tajikistan"
  },
  {
    "code": "TAN",
    "name": "Tanzania"
  },
  {
    "code": "THA",
    "name": "Thailand"
  },
  {
    "code": "TLS",
    "name": "Timor Leste"
  },
  {
    "code": "TOG",
    "name": "Togo"
  },
  {
    "code": "TKL",
    "name": "Tokelau"
  },
  {
    "code": "TGA",
    "name": "Tonga"
  },
  {
    "code": "TRI",
    "name": "Trinidad and Tobago"
  },
  {
    "code": "TUN",
    "name": "Tunisia"
  },
  {
    "code": "TUR",
    "name": "Turkey"
  },
  {
    "code": "TKM",
    "name": "Turkmenistan"
  },
  {
    "code": "TCA",
    "name": "Turks and Caicos Islands"
  },
  {
    "code": "TUV",
    "name": "Tuvalu"
  },
  {
    "code": "VIR",
    "name": "U.S. Virgin Islands"
  },
  {
    "code": "UGA",
    "name": "Uganda"
  },
  {
    "code": "UKR",
    "name": "Ukraine"
  },
  {
    "code": "UAE",
    "name": "United Arab Emirates"
  },
  {
    "code": "GBR",
    "name": "United Kingdom"
  },
  {
    "code": "URU",
    "name": "Uruguay"
  },
  {
    "code": "USA",
    "name": "USA"
  },
  {
    "code": "UZB",
    "name": "Uzbekistan"
  },
  {
    "code": "VAN",
    "name": "Vanuatu"
  },
  {
    "code": "VEN",
    "name": "Venezuela"
  },
  {
    "code": "VIE",
    "name": "Vietnam"
  },
  {
    "code": "WAL",
    "name": "Wales"
  },
  {
    "code": "WLF",
    "name": "Wallis and Futuna"
  },
  {
    "code": "ESH",
    "name": "Western Sahara"
  },
  {
    "code": "YEM",
    "name": "Yemen"
  },
  {
    "code": "ZAM",
    "name": "Zambia"
  },
  {
    "code": "ZIM",
    "name": "Zimbabwe"
  }
] as const;

export const NZF_GENDERS: readonly string[] = [
  "Male",
  "Female",
  "Non-binary"
] as const;

export const NZF_ETHNICITY_GROUPS: readonly NzfEthnicityGroup[] = [
  {
    "id": 1,
    "name": "NZ European",
    "minSelections": 0,
    "maxSelections": 0,
    "selections": []
  },
  {
    "id": 2,
    "name": "Māori",
    "minSelections": 0,
    "maxSelections": 4,
    "selections": [
      {
        "id": 133,
        "name": "Don't Know"
      },
      {
        "id": 1,
        "name": "Kāti Māmoe"
      },
      {
        "id": 2,
        "name": "Maungaharuru Tangitū"
      },
      {
        "id": 3,
        "name": "Moriori"
      },
      {
        "id": 4,
        "name": "Muaūpoko"
      },
      {
        "id": 5,
        "name": "Ngā Pōtiki ā Tamapahore"
      },
      {
        "id": 6,
        "name": "Ngā Rauru"
      },
      {
        "id": 7,
        "name": "Ngā Ruahine"
      },
      {
        "id": 8,
        "name": "Ngāi Tahu / Kāi Tahu"
      },
      {
        "id": 9,
        "name": "Ngāi Tai (Tauranga Moana/Mātaatua)"
      },
      {
        "id": 10,
        "name": "Ngāi Tai ki Tāmaki  "
      },
      {
        "id": 11,
        "name": "Ngāi Takoto"
      },
      {
        "id": 12,
        "name": "Ngāi Tāmanuhiri"
      },
      {
        "id": 13,
        "name": "Ngāi Te Ohuake (Rangitīkei)"
      },
      {
        "id": 14,
        "name": "Ngāi Te Rangi "
      },
      {
        "id": 15,
        "name": "Ngāpuhi"
      },
      {
        "id": 16,
        "name": "Ngāpuhi ki Whaingaroa-Ngāti Kahu ki Whaingaroa"
      },
      {
        "id": 17,
        "name": "Ngāti Apa (Rangitīkei)"
      },
      {
        "id": 18,
        "name": "Ngāti Apa ki Te Rā Tō"
      },
      {
        "id": 19,
        "name": "Ngāti Awa"
      },
      {
        "id": 20,
        "name": "Ngāti Hako"
      },
      {
        "id": 21,
        "name": "Ngāti Haua (Taumarunui)"
      },
      {
        "id": 22,
        "name": "Ngāti Haua (Waikato)"
      },
      {
        "id": 23,
        "name": "Ngāti Hauiti (Rangitīkei)"
      },
      {
        "id": 24,
        "name": "Ngāti Hei"
      },
      {
        "id": 25,
        "name": "Ngāti Hīkairo "
      },
      {
        "id": 26,
        "name": "Ngāti Hine (Te Tai Tokerau)"
      },
      {
        "id": 27,
        "name": "Ngāti Hineuru"
      },
      {
        "id": 28,
        "name": "Ngāti Kahu"
      },
      {
        "id": 29,
        "name": "Ngāti Kahungunu ki Heretaunga"
      },
      {
        "id": 30,
        "name": "Ngāti Kahungunu ki Tamakinui a Rua"
      },
      {
        "id": 31,
        "name": "Ngāti Kahungunu ki Tamatea"
      },
      {
        "id": 32,
        "name": "Ngāti Kahungunu ki Te Wairoa"
      },
      {
        "id": 33,
        "name": "Ngāti Kahungunu ki Te Whanganui-a-Orotu"
      },
      {
        "id": 34,
        "name": "Ngāti Kahungunu ki Wairarapa"
      },
      {
        "id": 35,
        "name": "Ngāti Kauwhata"
      },
      {
        "id": 36,
        "name": "Ngāti Kearoa / Ngāti Tuarā"
      },
      {
        "id": 37,
        "name": "Ngāti Koata"
      },
      {
        "id": 38,
        "name": "Ngāti Korokī Kahukura"
      },
      {
        "id": 39,
        "name": "Ngāti Kuia"
      },
      {
        "id": 40,
        "name": "Ngāti Kurī"
      },
      {
        "id": 41,
        "name": "Ngāti Mākino"
      },
      {
        "id": 42,
        "name": "Ngāti Manawa"
      },
      {
        "id": 43,
        "name": "Ngāti Maniapoto"
      },
      {
        "id": 44,
        "name": "Ngāti Manuhiri"
      },
      {
        "id": 45,
        "name": "Ngāti Maru (Hauraki)"
      },
      {
        "id": 46,
        "name": "Ngāti Maru (Taranaki)"
      },
      {
        "id": 47,
        "name": "Ngāti Mutunga (Taranaki)"
      },
      {
        "id": 48,
        "name": "Ngāti Mutunga (Wharekauri/Chatham Islands)"
      },
      {
        "id": 49,
        "name": "Ngāti Pāhauwera"
      },
      {
        "id": 50,
        "name": "Ngāti Paoa"
      },
      {
        "id": 51,
        "name": "Ngāti Pikiao (Te Arawa)"
      },
      {
        "id": 52,
        "name": "Ngāti Porou"
      },
      {
        "id": 53,
        "name": "Ngāti Porou ki Harataunga ki Mataora"
      },
      {
        "id": 54,
        "name": "Ngāti Pūkenga"
      },
      {
        "id": 55,
        "name": "Ngāti Pūkenga ki Waiau"
      },
      {
        "id": 56,
        "name": "Ngāti Rāhiri Tumutumu"
      },
      {
        "id": 57,
        "name": "Ngāti Rākaipaaka"
      },
      {
        "id": 58,
        "name": "Ngāti Rangi (Ruapehu, Whanganui)"
      },
      {
        "id": 59,
        "name": "Ngāti Ranginui"
      },
      {
        "id": 60,
        "name": "Ngāti Rangiteaorere (Te Arawa)"
      },
      {
        "id": 61,
        "name": "Ngāti Rangitihi (Te Arawa)"
      },
      {
        "id": 62,
        "name": "Ngāti Rangiwewehi (Te Arawa)"
      },
      {
        "id": 63,
        "name": "Ngāti Rārua"
      },
      {
        "id": 64,
        "name": "Ngāti Raukawa (Horowhenua/Manawatū)"
      },
      {
        "id": 65,
        "name": "Ngati Rehua"
      },
      {
        "id": 66,
        "name": "Ngāti Rongomai (Te Arawa)"
      },
      {
        "id": 67,
        "name": "Ngāti Ruanui"
      },
      {
        "id": 68,
        "name": "Ngāti Ruapani ki Waikaremoana"
      },
      {
        "id": 69,
        "name": "Ngāti Tahu-Ngāti Whaoa (Te Arawa)"
      },
      {
        "id": 70,
        "name": "Ngāti Tama (Taranaki)"
      },
      {
        "id": 71,
        "name": "Ngāti Tama (Te Waipounamu/South Island)"
      },
      {
        "id": 72,
        "name": "Ngāti Tama ki Te Upoko o Te Ika (Te Whanganui-a-Tara/Wellington)"
      },
      {
        "id": 73,
        "name": "Ngāti Tamakōpiri (Rangitīkei)"
      },
      {
        "id": 74,
        "name": "Ngāti Tamaoho"
      },
      {
        "id": 75,
        "name": "Ngāti Tamaterā"
      },
      {
        "id": 76,
        "name": "Ngāti Tara Tokanui"
      },
      {
        "id": 77,
        "name": "Ngāti Tarāwhai (Te Arawa)"
      },
      {
        "id": 78,
        "name": "Ngāti Te Ata"
      },
      {
        "id": 79,
        "name": "Ngāti Tiipa"
      },
      {
        "id": 80,
        "name": "Ngāti Toarangatira (Te Waipounamu/South Island)"
      },
      {
        "id": 81,
        "name": "Ngāti Toarangatira (Te Whanganui-a-Tara/Wellington)"
      },
      {
        "id": 82,
        "name": "Ngāti Tukorehe "
      },
      {
        "id": 83,
        "name": "Ngāti Tūwharetoa (ki Taupō)"
      },
      {
        "id": 84,
        "name": "Ngāti Tūwharetoa ki Kawerau "
      },
      {
        "id": 85,
        "name": "Ngāti Wai"
      },
      {
        "id": 295,
        "name": "Ngāti Wairere"
      },
      {
        "id": 86,
        "name": "Ngāti Whakaue (Te Arawa)"
      },
      {
        "id": 87,
        "name": "Ngāti Whanaunga"
      },
      {
        "id": 88,
        "name": "Ngāti Whare"
      },
      {
        "id": 89,
        "name": "Ngāti Whātua (not Ōrākei or Kaipara)"
      },
      {
        "id": 90,
        "name": "Ngāti Whātua o Kaipara"
      },
      {
        "id": 91,
        "name": "Ngāti Whātua o Ōrākei"
      },
      {
        "id": 92,
        "name": "Ngāti Whitikaupeka (Rangitīkei)"
      },
      {
        "id": 93,
        "name": "Pakakohi"
      },
      {
        "id": 94,
        "name": "Patukirikiri"
      },
      {
        "id": 95,
        "name": "Rangitāne (Manawatū)"
      },
      {
        "id": 96,
        "name": "Rangitāne (Te Matau-a-Māui/Hawke's Bay/Wairarapa)"
      },
      {
        "id": 97,
        "name": "Rangitāne (Te Waipounamu/South Island)"
      },
      {
        "id": 98,
        "name": "Rangitāne o Tamaki nui ā Rua"
      },
      {
        "id": 99,
        "name": "Raukawa (Waikato)"
      },
      {
        "id": 100,
        "name": "Rereahu"
      },
      {
        "id": 101,
        "name": "Rongomaiwahine (Te Māhia)"
      },
      {
        "id": 102,
        "name": "Rongowhakaata"
      },
      {
        "id": 103,
        "name": "Tamahaki (Ruapehu, Waimarino)"
      },
      {
        "id": 104,
        "name": "Tamakana (Ruapehu, Waimarino)"
      },
      {
        "id": 105,
        "name": "Tangāhoe"
      },
      {
        "id": 106,
        "name": "Tapuika (Te Arawa)"
      },
      {
        "id": 107,
        "name": "Taranaki"
      },
      {
        "id": 108,
        "name": "Te Aitanga ā Hauiti"
      },
      {
        "id": 109,
        "name": "Te Aitanga-a-Māhaki"
      },
      {
        "id": 110,
        "name": "Te Ākitai-Waiohua"
      },
      {
        "id": 111,
        "name": "Te Ati Haunui-a-Pāpārangi"
      },
      {
        "id": 112,
        "name": "Te Atiawa (Taranaki)"
      },
      {
        "id": 113,
        "name": "Te Atiawa (Te Waipounamu/South Island)"
      },
      {
        "id": 114,
        "name": "Te Atiawa (Te Whanganui-a-Tara/Wellington)"
      },
      {
        "id": 115,
        "name": "Te Atiawa ki Whakarongotai"
      },
      {
        "id": 116,
        "name": "Te Aupōuri"
      },
      {
        "id": 117,
        "name": "Te Hika o Pāpāuma"
      },
      {
        "id": 118,
        "name": "Te Kawerau ā Maki"
      },
      {
        "id": 119,
        "name": "Te Paatu"
      },
      {
        "id": 120,
        "name": "Te Rarawa"
      },
      {
        "id": 121,
        "name": "Te Roroa"
      },
      {
        "id": 122,
        "name": "Te Upokorehe"
      },
      {
        "id": 123,
        "name": "Te Uri-o-Hau"
      },
      {
        "id": 124,
        "name": "Te Whānau-ā-Apanui"
      },
      {
        "id": 125,
        "name": "Tūhoe"
      },
      {
        "id": 126,
        "name": "Tūhourangi (Te Arawa)"
      },
      {
        "id": 127,
        "name": "Uenuku (Ruapehu, Waimarino)"
      },
      {
        "id": 128,
        "name": "Uenuku-Kōpako (Te Arawa)"
      },
      {
        "id": 129,
        "name": "Waikato"
      },
      {
        "id": 130,
        "name": "Waitaha (Te Arawa)"
      },
      {
        "id": 131,
        "name": "Waitaha (Te Waipounamu/South Island)"
      },
      {
        "id": 132,
        "name": "Whakatōhea"
      }
    ]
  },
  {
    "id": 3,
    "name": "Pacific Peoples",
    "minSelections": 1,
    "maxSelections": 2,
    "selections": [
      {
        "id": 134,
        "name": "Cook Islands Māori"
      },
      {
        "id": 135,
        "name": "Fijian"
      },
      {
        "id": 136,
        "name": "Hawaiian"
      },
      {
        "id": 137,
        "name": "Indigenous Australian"
      },
      {
        "id": 138,
        "name": "Kiribati"
      },
      {
        "id": 139,
        "name": "Nauruan"
      },
      {
        "id": 140,
        "name": "Ni Vanuatu"
      },
      {
        "id": 141,
        "name": "Niuean"
      },
      {
        "id": 151,
        "name": "Other Pacific Islander"
      },
      {
        "id": 142,
        "name": "Papua New Guinean"
      },
      {
        "id": 143,
        "name": "Pitcairn Islander"
      },
      {
        "id": 144,
        "name": "Rotuman"
      },
      {
        "id": 145,
        "name": "Samoan"
      },
      {
        "id": 146,
        "name": "Solomon Islander"
      },
      {
        "id": 147,
        "name": "Tahitian"
      },
      {
        "id": 148,
        "name": "Tokelauan"
      },
      {
        "id": 149,
        "name": "Tongan"
      },
      {
        "id": 150,
        "name": "Tuvaluan"
      }
    ]
  },
  {
    "id": 4,
    "name": "Asian",
    "minSelections": 1,
    "maxSelections": 2,
    "selections": [
      {
        "id": 152,
        "name": "Afghani"
      },
      {
        "id": 153,
        "name": "Anglo Indian"
      },
      {
        "id": 154,
        "name": "Bangladeshi"
      },
      {
        "id": 155,
        "name": "Bengali"
      },
      {
        "id": 156,
        "name": "Bhutanese"
      },
      {
        "id": 157,
        "name": "Burmese"
      },
      {
        "id": 158,
        "name": "Cambodian"
      },
      {
        "id": 159,
        "name": "Cambodian Chinese"
      },
      {
        "id": 160,
        "name": "Chinese"
      },
      {
        "id": 161,
        "name": "Eurasian"
      },
      {
        "id": 162,
        "name": "Fijian Indian"
      },
      {
        "id": 163,
        "name": "Filipino"
      },
      {
        "id": 164,
        "name": "Hong Kong Chinese"
      },
      {
        "id": 165,
        "name": "Indian"
      },
      {
        "id": 166,
        "name": "Indian Tamil"
      },
      {
        "id": 167,
        "name": "Indonesian"
      },
      {
        "id": 168,
        "name": "Japanese"
      },
      {
        "id": 170,
        "name": "Korean"
      },
      {
        "id": 171,
        "name": "Lao"
      },
      {
        "id": 172,
        "name": "Malay"
      },
      {
        "id": 173,
        "name": "Malaysian Chinese"
      },
      {
        "id": 174,
        "name": "Malaysian Indian"
      },
      {
        "id": 175,
        "name": "Maldivian"
      },
      {
        "id": 176,
        "name": "Mongolian"
      },
      {
        "id": 177,
        "name": "Nepalese"
      },
      {
        "id": 192,
        "name": "Other Asian"
      },
      {
        "id": 178,
        "name": "Pakistani"
      },
      {
        "id": 179,
        "name": "Punjabi"
      },
      {
        "id": 180,
        "name": "Sikh"
      },
      {
        "id": 181,
        "name": "Singaporean Chinese"
      },
      {
        "id": 182,
        "name": "Sinhalese"
      },
      {
        "id": 183,
        "name": "South African Indian"
      },
      {
        "id": 184,
        "name": "Southeast Asian"
      },
      {
        "id": 185,
        "name": "Sri Lankan"
      },
      {
        "id": 186,
        "name": "Sri Lankan Tamil"
      },
      {
        "id": 187,
        "name": "Taiwanese"
      },
      {
        "id": 188,
        "name": "Thai"
      },
      {
        "id": 189,
        "name": "Tibetan"
      },
      {
        "id": 190,
        "name": "Vietnamese"
      },
      {
        "id": 191,
        "name": "Vietnamese Chinese"
      }
    ]
  },
  {
    "id": 5,
    "name": "Other",
    "minSelections": 1,
    "maxSelections": 2,
    "selections": [
      {
        "id": 296,
        "name": "New Zealander"
      },
      {
        "id": 294,
        "name": "Other Ethnicity"
      }
    ]
  },
  {
    "id": 6,
    "name": "MELAA",
    "minSelections": 1,
    "maxSelections": 2,
    "selections": [
      {
        "id": 193,
        "name": "African"
      },
      {
        "id": 194,
        "name": "African American"
      },
      {
        "id": 197,
        "name": "Algerian"
      },
      {
        "id": 199,
        "name": "Arab"
      },
      {
        "id": 200,
        "name": "Argentinian"
      },
      {
        "id": 202,
        "name": "Assyrian"
      },
      {
        "id": 207,
        "name": "Bolivian"
      },
      {
        "id": 209,
        "name": "Brazilian"
      },
      {
        "id": 212,
        "name": "Burundian"
      },
      {
        "id": 214,
        "name": "Caribbean"
      },
      {
        "id": 217,
        "name": "Chilean"
      },
      {
        "id": 218,
        "name": "Colombian"
      },
      {
        "id": 219,
        "name": "Congolese"
      },
      {
        "id": 227,
        "name": "Ecuadorian"
      },
      {
        "id": 228,
        "name": "Egyptian"
      },
      {
        "id": 230,
        "name": "Eritrean"
      },
      {
        "id": 232,
        "name": "Ethiopian"
      },
      {
        "id": 237,
        "name": "Ghanaian"
      },
      {
        "id": 243,
        "name": "Iranian/Persian"
      },
      {
        "id": 244,
        "name": "Iraqi"
      },
      {
        "id": 246,
        "name": "Israeli/Jewish"
      },
      {
        "id": 248,
        "name": "Jamaican"
      },
      {
        "id": 249,
        "name": "Jordanian"
      },
      {
        "id": 250,
        "name": "Kenyan"
      },
      {
        "id": 251,
        "name": "Kurd"
      },
      {
        "id": 252,
        "name": "Latin American"
      },
      {
        "id": 254,
        "name": "Lebanese"
      },
      {
        "id": 260,
        "name": "Mexican"
      },
      {
        "id": 261,
        "name": "Middle Eastern"
      },
      {
        "id": 262,
        "name": "Moroccan"
      },
      {
        "id": 264,
        "name": "Nigerian"
      },
      {
        "id": 266,
        "name": "Palestinian"
      },
      {
        "id": 267,
        "name": "Peruvian"
      },
      {
        "id": 270,
        "name": "Puerto Rican"
      },
      {
        "id": 279,
        "name": "Somali"
      },
      {
        "id": 283,
        "name": "Sudanese"
      },
      {
        "id": 286,
        "name": "Syrian"
      },
      {
        "id": 287,
        "name": "Turkish"
      },
      {
        "id": 289,
        "name": "Uruguayan"
      },
      {
        "id": 290,
        "name": "Venezuelan"
      },
      {
        "id": 292,
        "name": "Zambian"
      }
    ]
  },
  {
    "id": 7,
    "name": "Other European",
    "minSelections": 1,
    "maxSelections": 2,
    "selections": [
      {
        "id": 195,
        "name": "Afrikaner"
      },
      {
        "id": 196,
        "name": "Albanian"
      },
      {
        "id": 198,
        "name": "American"
      },
      {
        "id": 201,
        "name": "Armenian"
      },
      {
        "id": 203,
        "name": "Australian"
      },
      {
        "id": 204,
        "name": "Austrian"
      },
      {
        "id": 205,
        "name": "Belgian"
      },
      {
        "id": 206,
        "name": "Belorussian"
      },
      {
        "id": 208,
        "name": "Bosnian"
      },
      {
        "id": 210,
        "name": "British"
      },
      {
        "id": 211,
        "name": "Bulgarian"
      },
      {
        "id": 213,
        "name": "Canadian"
      },
      {
        "id": 215,
        "name": "Celtic"
      },
      {
        "id": 216,
        "name": "Channel Islander"
      },
      {
        "id": 220,
        "name": "Cornish"
      },
      {
        "id": 221,
        "name": "Croatian"
      },
      {
        "id": 222,
        "name": "Cypriot"
      },
      {
        "id": 223,
        "name": "Czech"
      },
      {
        "id": 224,
        "name": "Dalmatian"
      },
      {
        "id": 225,
        "name": "Danish"
      },
      {
        "id": 226,
        "name": "Dutch"
      },
      {
        "id": 229,
        "name": "English"
      },
      {
        "id": 231,
        "name": "Estonian"
      },
      {
        "id": 233,
        "name": "Finnish"
      },
      {
        "id": 234,
        "name": "Flemish"
      },
      {
        "id": 235,
        "name": "French"
      },
      {
        "id": 236,
        "name": "German"
      },
      {
        "id": 238,
        "name": "Greek"
      },
      {
        "id": 239,
        "name": "Gypsy"
      },
      {
        "id": 240,
        "name": "Hungarian"
      },
      {
        "id": 241,
        "name": "Icelandic"
      },
      {
        "id": 245,
        "name": "Irish"
      },
      {
        "id": 247,
        "name": "Italian"
      },
      {
        "id": 253,
        "name": "Latvian"
      },
      {
        "id": 255,
        "name": "Lithuanian"
      },
      {
        "id": 256,
        "name": "Macedonian"
      },
      {
        "id": 257,
        "name": "Maltese"
      },
      {
        "id": 258,
        "name": "Manx"
      },
      {
        "id": 263,
        "name": "New Caledonian"
      },
      {
        "id": 265,
        "name": "Norwegian"
      },
      {
        "id": 268,
        "name": "Polish"
      },
      {
        "id": 269,
        "name": "Portuguese"
      },
      {
        "id": 271,
        "name": "Romanian"
      },
      {
        "id": 272,
        "name": "Russian"
      },
      {
        "id": 273,
        "name": "Scottish"
      },
      {
        "id": 274,
        "name": "Serbian"
      },
      {
        "id": 276,
        "name": "Slavic"
      },
      {
        "id": 277,
        "name": "Slovak"
      },
      {
        "id": 278,
        "name": "Slovenian"
      },
      {
        "id": 280,
        "name": "South African European"
      },
      {
        "id": 281,
        "name": "South Slav"
      },
      {
        "id": 282,
        "name": "Spanish"
      },
      {
        "id": 284,
        "name": "Swedish"
      },
      {
        "id": 285,
        "name": "Swiss"
      },
      {
        "id": 288,
        "name": "Ukrainian"
      },
      {
        "id": 291,
        "name": "Welsh"
      },
      {
        "id": 293,
        "name": "Zimbabwean European"
      }
    ]
  }
] as const;
