// Taxonomy and categorization rules: the single source of truth.
//
// Edit this file by hand. dashboard/engine.js reads these tables to categorize
// every uploaded bank export, and the review panel builds its pickers from
// TAXONOMY. After any change, run the tests:   node --test
//
// Pattern syntax: regex fragments matched against the NORMALIZED description
// (lowercase, accents stripped), with word boundaries added by compileRule().
// Keep them ASCII and avoid \b, \w and \p{...}.


// ---- Taxonomy ----
// The complete list of Category -> Sub-category pairs that may exist.
// The review panel builds its pickers from this and refuses anything
// outside it.
const TAXONOMY = {
  "Expense": {
    "Saúde": [
      "Lentes",
      "Fisioterapia",
      "Farmácia",
      "Consultas/Exames",
      "Outros"
    ],
    "Investimentos": [
      "ETFs/DEGIRO",
      "PPR",
      "Trade Republic",
      "Outros"
    ],
    "Alimentação": [
      "Compras",
      "Restaurantes",
      "Café/Padaria",
      "Take-away/Delivery",
      "Outros"
    ],
    "Lazer": [
      "Escape Room",
      "Saídas Noite/Bares",
      "Férias",
      "Cinema/Espetáculos",
      "LEGO/Pop-Culture/Memorabilia",
      "Roupa",
      "Subscrições",
      "Compras Online",
      "Gaming",
      "Outros"
    ],
    "Educação": [
      "Cursos/Formação",
      "Livros/Material",
      "Outros"
    ],
    "Geral": [
      "Gasóleo",
      "Carro",
      "Telemóvel",
      "Transportes",
      "Estacionamento",
      "Casa",
      "Seguros",
      "Comissões e Impostos",
      "Revolut",
      "Outros"
    ],
    "Desporto": [
      "Futebol",
      "Corrida",
      "Ginásio",
      "Equipamento",
      "Outros"
    ],
    "Prendas": [
      "Aniversário",
      "Natal",
      "Outros"
    ],
    "Cabelo": [
      "Cabeleireiro/Barbeiro",
      "Produtos",
      "Outros"
    ],
    "Outros": [
      "Por Classificar",
      "Outros",
      "Levantamento",
      "Transferências Pessoais"
    ]
  },
  "Income": {
    "Salário": [
      "Salário",
      "Outros"
    ],
    "Salário Alimentação": [
      "Salário Alimentação"
    ],
    "Transferências Pessoais": [
      "MBWay",
      "Transferência"
    ],
    "Subsídios": [
      "Desemprego",
      "Outros"
    ],
    "Reembolsos": [
      "IRS",
      "Seguros",
      "Estornos"
    ],
    "Outros": [
      "Por Classificar",
      "Outros"
    ]
  },
  "Transfer": {
    "Transferências Internas": [
      "Entre contas",
      "Reforço CRP"
    ]
  }
};

// ---- Legacy pairs ----
// Keyed "Type|Category|sub-category" with the sub-category lowercased;
// a "*" sub-category matches any. resolvePair() in index.html uses this to
// place review decisions saved under a retired name.
const LEGACY_ALIASES = {
  // Example: a review saved as Expense / Refeição / supermercado before
  // the taxonomy was renamed is shown as Alimentação / Compras.
  // "Expense|Refeição|supermercado": ["Alimentação", "Compras"],
  // "Expense|Refeição|*": ["Alimentação", "Outros"],
};

const COLUMNS = ["transaction_id", "Date", "Type", "Category", "Sub-category", "Method", "Amount (€)", "Notes", "Review Note", "Reviewed At", "Month", "Year", "Source File", "Balance (€)"];
const TYPE_INCOME = "Income";
const TYPE_EXPENSE = "Expense";
const TYPE_TRANSFER = "Transfer";
const INTERNAL_CATEGORY = "Transferências Internas";
const EXPENSE_CATEGORIES = ["Saúde", "Investimentos", "Alimentação", "Lazer", "Educação", "Geral", "Desporto", "Prendas", "Cabelo", "Outros"];
const INCOME_CATEGORIES = ["Salário", "Salário Alimentação", "Transferências Pessoais", "Subsídios", "Reembolsos", "Outros"];
const METHODS = ["Cartão", "MBWay", "Transferência", "Débito Direto", "Cartão Alimentação", "Dinheiro", "Levantamento", "Não especificado"];
const UNSPECIFIED_METHOD = "Não especificado";
const MEAL_CARD_METHOD = "Cartão Alimentação";
const SAVINGS_CATEGORY = "Investimentos";
const TR_SAVINGS_SUB = "Trade Republic";
const TR_INTEREST_RATE = 0.03;
const TR_INTEREST_TAX = 0.28;
const UNCLASSIFIED_CATEGORY = "Outros";
const UNCLASSIFIED_SUB = "Por Classificar";
const REVIEW_NOTE = "Review Note";
const REVIEWED_AT = "Reviewed At";

// ---- Rule tables ----
// Each rule: [patterns, category, sub_category, suggestedMethod].
// `patterns` are regex fragments matched against the NORMALIZED
// description (lowercased, accents stripped) with word boundaries
// added by compileRule(). The suggested method is a default only —
// the rail is detected separately by overlayMethod() and wins
// whenever the description names one.
const GATEWAY_PATTERNS = ["nuvei", "easypay", "eupago", "safecharge", "payshop", "stripe", "adyen", "worldpay", "redunicre"];
// Money in with one of these words is a refund: categorized on the
// expense side and stored as a negative expense .
const REFUND_PATTERNS = ["devolucao", "devolucoes", "estorno", "estornos"];
// Internal transfers: money moving between your own accounts. Stored with
// Type "Transfer" and a signed amount (+ in, - out), kept out of every income
// and expense total, and shown in the Transactions table.
// Each rule: [patterns, sub_category].
const INTERNAL_RULES = [
  [["transferencia entre contas"], "Entre contas"],
  [["reforco crp"], "Reforço CRP"],
];

const PURPOSE_INCOME_RULES = [
  [["subsidio de alimentacao", "cartao alimentacao", "cheque refeicao", "ticket refeicao", "coverflex", "edenred"], "Salário Alimentação", "Salário Alimentação", "Transferência"],
  [["ordenado", "salario", "vencimento", "remuneracao", "retroativo", "retroativos"], "Salário", "Salário", "Transferência"],
  [["irs", "reembolso irs", "reembolsos irs", "autoridade tributaria", "financas"], "Reembolsos", "IRS", "Transferência"],
  [["seguro", "seguros", "fidelidade", "tranquilidade", "ageas", "zurich", "generali"], "Reembolsos", "Seguros", "Transferência"],
  [["reembolso", "reembolsos", "credito a favor"], "Reembolsos", "Estornos", "Transferência"],
  [["desemprego", "subsidio de desemprego", "seguranca social"], "Subsídios", "Desemprego", "Transferência"],
  [["subsidio", "subsidios", "abono"], "Subsídios", "Outros", "Transferência"],
];

const PURPOSE_EXPENSE_RULES = [
  // An MBWay payment the bank names no one for: too vague for any category.
  [["trf\\.? mb ?way emitida"], "Outros", "Outros", "MBWay"],
  [["manutencao de conta", "comiss(?:ao|oes)", "imposto do selo", "imposto de selo", "despesas bancarias", "anuidade", "juros", "disponibilizacao de cartao", "taxa", "taxas", "alfandeg[a-z]*"], "Geral", "Comissões e Impostos", "Débito Direto"],
  [["levantamento", "levantamentos", "atm", "multibanco levantamento"], "Outros", "Levantamento", "Levantamento"],
  [["degiro", "trading ?212", "xtb", "etoro", "interactive brokers", "etf", "etfs", "xetra", "corretora"], "Investimentos", "ETFs/DEGIRO", "Transferência"],
  [["ppr", "sgf", "fundo de pens(?:ao|oes)", "fundos de pens(?:ao|oes)", "poupanca reforma", "gestora de fundo", "gestora fundo"], "Investimentos", "PPR", "Transferência"],
  [["continente", "pingo doce", "lidl", "aldi", "mercadona", "minipreco", "auchan", "intermarche", "jumbo", "recheio", "supermercado", "supermercato", "mercearia", "talho", "frutaria", "el corte ingles"], "Alimentação", "Compras", "Cartão"],
  [["uber eats", "glovo", "bolt food", "mc ?donald[a-z]*", "burger king", "kfc", "telepizza", "pizza hut", "dominos"], "Alimentação", "Take-away/Delivery", "Cartão"],
  [["padaria", "pastelaria", "confeitaria", "cafe", "caffe", "brunch", "gelataria", "queijaria", "chocolate", "doces", "pequeno almoco", "pe almoco", "pequenos almocos"], "Alimentação", "Café/Padaria", "Cartão"],
  [["discoteca", "boite", "nightclub", "pub", "bar", "bares", "cocktail", "cocktails", "beer", "cerveja", "cervejas", "jazz", "taberna", "tasquinha", "adega"], "Lazer", "Saídas Noite/Bares", "Cartão"],
  [["restaurante", "restaurantes", "rest", "tasca", "churrasqueira", "churrasco", "marisqueira", "cervejaria", "pizzaria", "trattoria", "petisco", "petiscos", "bifanas", "brasao", "brasa", "grill", "sushi", "snack", "esplanada", "almoco", "almocos", "jantar", "jantares", "comida", "lanche", "refeicao", "pizz[a-z]*", "gaucho", "cantina", "montaditos", "areas portugal", "churrascaria", "marisco", "mariscos"], "Alimentação", "Restaurantes", "Cartão"],
  [["netflix", "spotify", "disney", "hbo", "max", "twitch", "youtube premium", "amazon prime", "crunchyroll", "playstation plus", "xbox game pass", "subscricao"], "Lazer", "Subscrições", "Cartão"],
  [["amazon", "ebay", "aliexpress", "shein", "temu", "asos", "zalando"], "Lazer", "Compras Online", "Cartão"],
  [["lego", "funko", "warhammer", "bandai", "fnac", "gamestop", "colecionaveis"], "Lazer", "LEGO/Pop-Culture/Memorabilia", "Cartão"],
  [["steam games", "steampowered", "playstation", "psn", "nintendo", "xbox", "epic games", "riot games", "blizzard", "ubisoft", "ea games", "fifa[a-z0-9]*", "eneba"], "Lazer", "Gaming", "Cartão"],
  [["escape room", "escape rooms"], "Lazer", "Escape Room", "Cartão"],
  [["cinema", "cinemas", "uci", "teatro", "museu", "museus", "concerto", "concertos", "espetaculo", "espetaculos", "coliseu", "altice arena", "comedia", "casino"], "Lazer", "Cinema/Espetáculos", "Cartão"],
  [["booking", "airbnb", "ryanair", "easyjet[a-z0-9]*", "tap", "latam", "vueling", "hotel", "hostel", "civitatis", "aeroporto", "aerop", "turismo", "viagem", "viagens", "ferias"], "Lazer", "Férias", "Cartão"],
  [["zara", "h&m", "primark", "bershka", "stradivarius", "pull & bear", "tiger", "pandora", "hawkers", "tedi", "sapataria", "boutique", "roupa", "roupas", "camisola", "carhart[a-z]*"], "Lazer", "Roupa", "Cartão"],
  [["bowling", "minigolfe", "mini golfe", "karting", "kart", "paintball", "trampolins", "arcade"], "Lazer", "Outros", "Cartão"],
  [["ginasio", "fitness", "holmes place", "solinca", "gym", "smart club", "crossfit"], "Desporto", "Ginásio", "Cartão"],
  [["futebol", "sport lisboa", "fc porto", "sporting", "benfica", "estadio", "stadium", "arena", "bilhete jogo"], "Desporto", "Futebol", "Cartão"],
  [["corrida", "corridas", "running", "maratona", "triatlo", "trail", "sao silvestre"], "Desporto", "Corrida", "Cartão"],
  [["decathlon", "sport zone", "nike", "adidas", "jd sports"], "Desporto", "Equipamento", "Cartão"],
  [["lentes", "optica", "opticas", "oculos", "multiopticas", "opticalia", "alain afflelou", "oftalmolog[a-z]*"], "Saúde", "Lentes", "Cartão"],
  [["fisioterapia", "fisiatria", "osteopatia"], "Saúde", "Fisioterapia", "Cartão"],
  [["farmacia", "farmacias", "parafarmacia", "wells", "well s"], "Saúde", "Farmácia", "Cartão"],
  [["hospital", "clinica", "clin", "cuf", "lusiadas", "unilabs", "laboratorio", "analises", "dentista", "medicina dentaria", "consulta", "consultas", "medico", "medica"], "Saúde", "Consultas/Exames", "Cartão"],
  [["livraria", "wook", "bertrand", "papelaria", "papel"], "Educação", "Livros/Material", "Cartão"],
  [["curso", "cursos", "formacao", "universidade", "propina", "propinas", "explicacoes", "academia"], "Educação", "Cursos/Formação", "Cartão"],
  [["prenda", "prendas", "presente", "presentes", "florista", "flores", "aniversario"], "Prendas", "Outros", "Cartão"],
  [["gasoleo", "gasolina", "combustivel", "combustiveis", "galp", "repsol", "cepsa", "prio", "bp"], "Geral", "Gasóleo", "Cartão"],
  [["estacionam[a-z]*", "parquimetro[a-z]*", "parque de estac[a-z]*", "empark", "telpark", "saba parques", "parking"], "Geral", "Estacionamento", "Cartão"],
  [["uber(?! eats)", "bolt(?! food)", "taxi", "comboios", "cp comboios", "metro do porto", "stcp", "via verde", "portagem", "portagens", "brisa", "ascendi"], "Geral", "Transportes", "Cartão"],
  [["oficina", "pneus", "pneu", "inspecao", "revisao", "iuc", "stand auto", "auto reparacao", "bateria auto"], "Geral", "Carro", "Cartão"],
  [["vodaf[a-z]*", "vdaf[a-z]*", "meo", "nowo", "nos", "telemovel", "telecomunicacoes", "carregamento telemovel"], "Geral", "Telemóvel", "Cartão"],
  [["seguro", "seguros", "allianz seguros", "fidelidade", "tranquilidade", "ageas", "zurich", "generali", "una seguros"], "Geral", "Seguros", "Débito Direto"],
  [["renda", "condominio", "prestacao casa", "credito habitacao", "edp", "endesa", "iberdrola", "aguas de", "epal", "ikea", "leroy merlin", "energia", "energy", "gas natural", "galp energia"], "Geral", "Casa", "Débito Direto"],
  [["revolut"], "Geral", "Revolut", "Transferência"],
  [["^[0-9a-f]{16}$"], "Geral", "Revolut", "Cartão"],
  [["trade ?republic"], "Investimentos", "Trade Republic", "Transferência"],
];
