const PDFDocument = require('pdfkit');

const GOLD = '#c9911f';
const BLACK = '#0a0a0a';
const DIM = '#555555';

function buildTicketPdf({ eventInfo, order, ticket }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [320, 620], margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, 320, 620).fill(BLACK);

    doc
      .fillColor(GOLD)
      .font('Helvetica-Bold')
      .fontSize(26)
      .text(eventInfo.name, 0, 40, { width: 320, align: 'center' });

    doc
      .fillColor('#ffffff')
      .font('Helvetica')
      .fontSize(11)
      .text(`${eventInfo.dateLabel}  -  ${eventInfo.venue}`, 24, 76, { width: 272, align: 'center' });

    doc.moveTo(40, 108).lineTo(280, 108).strokeColor(GOLD).lineWidth(1).stroke();

    doc
      .fillColor(GOLD)
      .font('Helvetica-Bold')
      .fontSize(12)
      .text('INGRESSO', 0, 124, { width: 320, align: 'center' });

    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(order.buyerName, 24, 148, { width: 272, align: 'center' });

    doc
      .fillColor(DIM)
      .font('Helvetica')
      .fontSize(11)
      .text(order.loteName || '', 24, 172, { width: 272, align: 'center' });

    const qrBuffer = Buffer.from(ticket.qrCodeBase64, 'base64');
    doc.roundedRect(60, 200, 200, 200, 8).fill('#ffffff');
    doc.image(qrBuffer, 70, 210, { width: 180, height: 180 });

    doc
      .fillColor(GOLD)
      .font('Helvetica-Bold')
      .fontSize(14)
      .text(ticket.code, 24, 418, { width: 272, align: 'center' });

    doc.moveTo(40, 450).lineTo(280, 450).strokeColor(GOLD).lineWidth(1).stroke();

    doc
      .fillColor('#cccccc')
      .font('Helvetica')
      .fontSize(9)
      .text(
        'Apresente este QR Code na entrada do evento. Ingresso pessoal e intransferivel, valido para uma unica entrada. Guarde este arquivo ate o dia da festa.',
        30,
        468,
        { width: 260, align: 'center', lineGap: 3 }
      );

    doc.end();
  });
}

module.exports = { buildTicketPdf };
