const { createWorkOrderPdf } = require('../utils/workOrderPdf');

async function generateWorkOrderPDF(workOrder, resCallback, services = [], materials = []) {
    try {
        const pdf = await createWorkOrderPdf(workOrder, services, materials);

        if (typeof resCallback === 'function') {
            resCallback(`/uploads/work-orders/${pdf.fileName}`);
        }

        return pdf;
    } catch (error) {
        console.error('Generate work order PDF error:', error);
        throw error;
    }
}

module.exports = { generateWorkOrderPDF };
