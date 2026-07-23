const express = require('express');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
const myCache = new NodeCache({ stdTTL: 600 }); // 10 min de cache

const SUPABASE_URL = 'https://bjmkrtumtuoypnkwvxbh.supabase.co';
// Coloquei a chave pura aqui pois no Apps Script já estava exposta no front, 
// mas em um app sério deveríamos puxar de process.env.SUPABASE_KEY
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJqbWtydHVtdHVveXBua3d2eGJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4MjAzNjMsImV4cCI6MjA4NDM5NjM2M30.DmmapzJz9ed0J7_IQhh1h5q7u-knKSnLi_WGOr-va4s';

const CUTOFF_DATE_PLANILHA_MS = new Date(2026, 5, 12, 23, 59, 59).getTime();
const CUTOFF_DATE_BANCO_MS = new Date(2026, 5, 12, 0, 0, 0).getTime();

// --- AUTENTICAÇÃO DO GOOGLE ---
let auth;
let sheets;
try {
    if (process.env.GOOGLE_CREDENTIALS) {
        let rawCreds = process.env.GOOGLE_CREDENTIALS;
        let credsObj;
        try {
            credsObj = JSON.parse(rawCreds);
        } catch (e1) {
            rawCreds = rawCreds.trim();
            if ((rawCreds.startsWith('"') && rawCreds.endsWith('"')) || (rawCreds.startsWith("'") && rawCreds.endsWith("'"))) {
                rawCreds = rawCreds.substring(1, rawCreds.length - 1);
            }
            credsObj = JSON.parse(rawCreds);
        }

        let privateKey = credsObj.private_key;
        if (privateKey && privateKey.includes('\\n')) {
            privateKey = privateKey.replace(/\\n/g, '\n');
        }

        auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: credsObj.client_email,
                private_key: privateKey,
                project_id: credsObj.project_id
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
    } else {
        auth = new google.auth.GoogleAuth({
            keyFile: 'credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
    }
    sheets = google.sheets({ version: 'v4', auth });
} catch (error) {
    console.error("ERRO NA LEITURA DA CHAVE DO GOOGLE:", error.message);
}

// --- FUNÇÕES UTILITÁRIAS ---
function formatDateToBR(dateString) {
    if (!dateString) return "";
    const parts = dateString.split('-');
    if (parts.length >= 3) {
        return `${parts[2].substring(0, 2)}/${parts[1]}/${parts[0]}`;
    }
    return dateString;
}

function parseNumber(value) {
    if (!value && value !== 0) return 0;
    let cleanValue = value.toString().replace('R$', '').trim();
    if (cleanValue === '') return 0;
    cleanValue = cleanValue.replace(/\./g, '');
    cleanValue = cleanValue.replace(',', '.');
    const num = parseFloat(cleanValue);
    return isNaN(num) ? 0 : Math.round(num);
}

async function fetchSupabase(endpoint) {
    try {
        const response = await axios.get(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
                'Accept-Profile': 'serralheria'
            }
        });
        return response.data;
    } catch (error) {
        console.error("Erro no Supabase:", error.message);
        return [];
    }
}

// --- LÓGICA DE DADOS ---
async function getProducaoData() {
    const processedData = [];

    // 1. Google Sheets (Antes de 12/06)
    if (sheets) {
        try {
            const ssId = '1B9YwKa7k7p59_FHz6RgiI72gndEite8WHvKm1AhaMxg';
            const response = await sheets.spreadsheets.values.get({ spreadsheetId: ssId, range: "CONTROLE DE PRODUÇÃO!A:Q" });
            const rows = response.data.values || [];
            
            rows.slice(1).forEach(row => {
                const dateStr = row[1];
                if (dateStr && dateStr !== "") {
                    const p = dateStr.split('/');
                    if (p.length === 3) {
                        const rowTime = new Date(p[2], p[1] - 1, p[0]).getTime();
                        if (rowTime <= CUTOFF_DATE_PLANILHA_MS) {
                            processedData.push({
                                data: dateStr, oficina: row[2], item: row[3],
                                internos: parseNumber(row[8]), producao: parseNumber(row[11]), saida: parseNumber(row[12]),
                                producaoDia: parseNumber(row[13]), estoqueDia: parseNumber(row[14]), estoqueGeral: parseNumber(row[15]),
                                observacoes: row[16] || "", 
                                origem: "PLANILHA", destino: "", justificativa: "", horarios: "",
                                subgrupos_producao: {}, subgrupos_saida: {}
                            });
                        }
                    }
                }
            });
        } catch (err) { console.error("Erro no Sheets:", err.message); }
    }

    // 2. Supabase (Entradas e Saídas pós 12/06)
    try {
        const [entradasRaw, saidasRaw] = await Promise.all([
            fetchSupabase('relatorio_producoes?select=qtd_produzida,observacao,justificativa,detalhes_subgrupos,relatorios_diarios(data_relatorio,numero_internos,horario_inicio,horario_fim,oficinas(nome)),produtos(nome)&limit=5000'),
            fetchSupabase('saida_itens?select=qtd_saida,detalhes_subgrupos,saidas_produtos(data_saida,observacao,destino),oficinas(nome),produtos(nome)&limit=5000')
        ]);

        entradasRaw.forEach(e => {
            if (!e.relatorios_diarios || !e.produtos || !e.relatorios_diarios.data_relatorio) return;
            const dbStr = e.relatorios_diarios.data_relatorio;
            const p = dbStr.split('-');
            const dbTime = new Date(p[0], p[1] - 1, p[2].substring(0,2)).getTime();
            
            if (dbTime >= CUTOFF_DATE_BANCO_MS) {
                let hInicio = e.relatorios_diarios.horario_inicio ? e.relatorios_diarios.horario_inicio.substring(0,5) : '';
                let hFim = e.relatorios_diarios.horario_fim ? e.relatorios_diarios.horario_fim.substring(0,5) : '';
                
                processedData.push({
                    data: formatDateToBR(dbStr),
                    oficina: e.relatorios_diarios.oficinas ? e.relatorios_diarios.oficinas.nome : "N/D",
                    item: e.produtos.nome, internos: parseNumber(e.relatorios_diarios.numero_internos),
                    producao: parseNumber(e.qtd_produzida), saida: 0, producaoDia: 0, estoqueDia: 0, estoqueGeral: 0,
                    observacoes: e.observacao || "",
                    origem: "BANCO", destino: "", justificativa: e.justificativa || "", horarios: (hInicio && hFim) ? `${hInicio} às ${hFim}` : "",
                    subgrupos_producao: e.detalhes_subgrupos || {}, 
                    subgrupos_saida: {}
                });
            }
        });

        saidasRaw.forEach(s => {
            if (!s.saidas_produtos || !s.produtos || !s.saidas_produtos.data_saida) return;
            const dbStr = s.saidas_produtos.data_saida;
            const p = dbStr.split('-');
            const dbTime = new Date(p[0], p[1] - 1, p[2].substring(0,2)).getTime();
            
            if (dbTime >= CUTOFF_DATE_BANCO_MS) {
                processedData.push({
                    data: formatDateToBR(dbStr),
                    oficina: s.oficinas ? s.oficinas.nome : "N/D", item: s.produtos.nome,
                    internos: 0, producao: 0, saida: parseNumber(s.qtd_saida), producaoDia: 0, estoqueDia: 0, estoqueGeral: 0,
                    observacoes: s.saidas_produtos.observacao || "",
                    origem: "BANCO", destino: s.saidas_produtos.destino || "N/I", justificativa: "", horarios: "",
                    subgrupos_producao: {}, 
                    subgrupos_saida: s.detalhes_subgrupos || {}
                });
            }
        });
    } catch (err) { console.error("Erro unindo Supabase:", err.message); }

    return processedData;
}

async function getProcessosData() {
    const processosRaw = await fetchSupabase('processos?select=id,numero,data_entrada,tipo_demanda,orgao,data_autorizacao,status,link_sei,prazo_finalizacao,processo_produtos(qtd_autorizada,qtd_entregue,observacao,subgrupo,produtos(nome)),processo_termos(numeracao,situacao,link_pdf,data_termo)&limit=5000');
    const processosMap = {};

    processosRaw.forEach(p => {
        const numProcesso = p.numero ? p.numero.trim().replace(/\./g, '') : "N/D";

        if (!processosMap[numProcesso]) {
            processosMap[numProcesso] = {
                n_processo: numProcesso, data_entrada: p.data_entrada ? formatDateToBR(p.data_entrada) : "N/I",
                tipo: p.tipo_demanda || "", orgao: p.orgao || "", autorizado: p.data_autorizacao ? "SIM" : "NÃO",
                status: p.status || "", link_sei: p.link_sei ? p.link_sei.trim() : "",
                qtd_autorizada_total: 0, qtd_entregue_total: 0, qtd_faltante_total: 0,
                itens: [], termos: []
            };
        }

        if (p.processo_termos && p.processo_termos.length > 0) {
            processosMap[numProcesso].termos = p.processo_termos.map(t => ({
                num: t.numeracao, situacao: t.situacao, pdf: t.link_pdf, data: t.data_termo ? formatDateToBR(t.data_termo) : ""
            }));
        }

        if (p.processo_produtos && p.processo_produtos.length > 0) {
            p.processo_produtos.forEach(pp => {
                const qAut = parseNumber(pp.qtd_autorizada);
                const qEnt = parseNumber(pp.qtd_entregue);
                
                processosMap[numProcesso].qtd_autorizada_total += qAut;
                processosMap[numProcesso].qtd_entregue_total += qEnt;
                processosMap[numProcesso].qtd_faltante_total += (qAut - qEnt);

                processosMap[numProcesso].itens.push({
                    material: pp.produtos ? pp.produtos.nome : "Desconhecido",
                    subgrupo: pp.subgrupo || "Geral",
                    data_aut: p.data_autorizacao ? formatDateToBR(p.data_autorizacao) : "",
                    qtd_aut: qAut, qtd_ent: qEnt, qtd_falt: (qAut - qEnt),
                    prazo: p.prazo_finalizacao ? formatDateToBR(p.prazo_finalizacao) : "",
                    situacao: p.status || "", observacao: pp.observacao || ""
                });
            });
        }
    });

    return Object.values(processosMap);
}

// --- ROTAS DO EXPRESS ---
app.get('/', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        let data = myCache.get('SERRALHERIA_DATA');

        if (!data || forceRefresh) {
            console.log("Montando dados híbridos (Sheets + Supabase)...");
            const [producao, processos] = await Promise.all([getProducaoData(), getProcessosData()]);
            data = { producao, processos };
            myCache.set('SERRALHERIA_DATA', data);
        }
        res.render('index', { INITIAL_DATA: JSON.stringify(data) });
    } catch (err) {
        console.error(err);
        res.status(500).send("Erro ao carregar o painel da Serralheria: " + err.message);
    }
});

app.get('/api/data', async (req, res) => {
    try {
        const [producao, processos] = await Promise.all([getProducaoData(), getProcessosData()]);
        const data = { producao, processos };
        myCache.set('SERRALHERIA_DATA', data);
        res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Serralheria rodando localmente em http://localhost:${PORT}`));
}

module.exports = app;