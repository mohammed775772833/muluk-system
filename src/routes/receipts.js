const express = require('express');
const pool = require('../../db');
const { authenticateToken, requirePermission } = require('../middleware/auth');

const router = express.Router();

/*
 * إنشاء سند قبض
 * POST /api/receipts
 */
router.post('/', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            work_order_id,
            amount,
            payment_method = 'CASH',
            notes = null
        } = req.body;

        const receiptAmount = Number(amount);

        if (!work_order_id || !Number.isFinite(receiptAmount) || receiptAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'رقم أمر التشغيل والمبلغ مطلوبان ويجب أن يكون المبلغ أكبر من صفر'
            });
        }

        await client.query('BEGIN');

        const orderResult = await client.query(`
            SELECT
                work_order_id,
                work_order_no,
                customer_id,
                total_amount,
                deposit_amount,
                balance_amount
            FROM work_orders
            WHERE work_order_id = $1
            FOR UPDATE
        `, [work_order_id]);

        if (orderResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'أمر التشغيل غير موجود'
            });
        }

        const order = orderResult.rows[0];

        if (receiptAmount > Number(order.balance_amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'مبلغ السند أكبر من المبلغ المتبقي على أمر التشغيل',
                balance_amount: Number(order.balance_amount)
            });
        }

        const numberResult = await client.query(`
            SELECT
                'MK-RC-' ||
                TO_CHAR(CURRENT_DATE, 'YYYY') ||
                '-' ||
                LPAD(
                    (
                        COALESCE(
                            MAX(
                                NULLIF(
                                    SUBSTRING(receipt_no FROM '([0-9]+)$'),
                                    ''
                                )::BIGINT
                            ),
                            0
                        ) + 1
                    )::TEXT,
                    6,
                    '0'
                ) AS receipt_no
            FROM payment_receipts
            WHERE receipt_no LIKE 'MK-RC-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-%'
        `);

        const receiptNo = numberResult.rows[0].receipt_no;

        const receiptResult = await client.query(`
            INSERT INTO payment_receipts (
                receipt_no,
                work_order_id,
                customer_id,
                amount,
                payment_method,
                received_by,
                notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [
            receiptNo,
            order.work_order_id,
            order.customer_id,
            receiptAmount,
            payment_method,
            req.user.user_id,
            notes
        ]);

        const newDeposit = Number(order.deposit_amount) + receiptAmount;

        await client.query(`
            UPDATE work_orders
            SET deposit_amount = $1
            WHERE work_order_id = $2
        `, [newDeposit, order.work_order_id]);

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'تم إنشاء سند القبض بنجاح',
            receipt: receiptResult.rows[0],
            work_order: {
                work_order_id: order.work_order_id,
                work_order_no: order.work_order_no,
                total_amount: Number(order.total_amount),
                deposit_amount: newDeposit,
                balance_amount: Math.max(Number(order.total_amount) - newDeposit, 0)
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create receipt error:', error);

        res.status(500).json({
            success: false,
            message: 'فشل إنشاء سند القبض'
        });
    } finally {
        client.release();
    }
});

/*
 * عرض سندات أمر تشغيل
 * GET /api/receipts/work-order/:id
 */
router.get('/work-order/:id', authenticateToken, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                pr.*,
                u.username AS received_by_username
            FROM payment_receipts pr
            LEFT JOIN users u ON u.user_id = pr.received_by
            WHERE pr.work_order_id = $1
            ORDER BY pr.received_at DESC, pr.receipt_id DESC
        `, [req.params.id]);

        res.json({
            success: true,
            receipts: result.rows
        });

    } catch (error) {
        console.error('Get receipts error:', error);

        res.status(500).json({
            success: false,
            message: 'فشل جلب سندات القبض'
        });
    }
});

router.get('/:id', authenticateToken, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                pr.receipt_id,
                pr.receipt_no,
                pr.amount,
                pr.payment_method,
                pr.received_at,
                pr.notes,

                w.work_order_id,
                w.work_order_no,
                w.total_amount,
                w.deposit_amount,
                w.balance_amount,

                c.customer_id,
                c.customer_no,
                c.full_name AS customer_name,
                c.phone AS customer_phone,

                v.vehicle_id,
                v.plate_no,
                v.make,
                v.model,
                v.model_year,
                v.color,

                u.username AS received_by_username
            FROM payment_receipts pr
            JOIN work_orders w
                ON w.work_order_id = pr.work_order_id
            JOIN customers c
                ON c.customer_id = pr.customer_id
            JOIN vehicles v
                ON v.vehicle_id = w.vehicle_id
            LEFT JOIN users u
                ON u.user_id = pr.received_by
            WHERE pr.receipt_id = $1
        `, [req.params.id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'سند القبض غير موجود'
            });
        }

        res.json({
            success: true,
            receipt: result.rows[0]
        });

    } catch (error) {
        console.error('Get receipt detail error:', error);

        res.status(500).json({
            success: false,
            message: 'فشل جلب بيانات سند القبض'
        });
    }
});


/*
 * إنشاء PDF لسند القبض مطابق للقالب
 * GET /api/receipts/:id/pdf
 */
router.get('/:id/pdf', authenticateToken, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const PDFDocument = require('pdfkit');
        const SVGtoPDF = require('svg-to-pdfkit');
        const fontkit = require('fontkit');
        const path = require('path');
        const fs = require('fs');
        const { rtlText } = require('bidi-shaper/pdfkit');

        const result = await pool.query(`
            SELECT
                pr.receipt_id,
                pr.receipt_no,
                pr.amount,
                pr.payment_method,
                pr.received_at,
                pr.notes,

                w.work_order_id,
                w.work_order_no,
                w.total_amount,
                w.deposit_amount,
                w.balance_amount,

                c.customer_id,
                c.customer_no,
                c.full_name AS customer_name,
                c.phone AS customer_phone,

                v.plate_no,
                v.make,
                v.model,
                v.model_year,
                v.color,

                u.username AS received_by_username
            FROM payment_receipts pr
            JOIN work_orders w
                ON w.work_order_id = pr.work_order_id
            JOIN customers c
                ON c.customer_id = pr.customer_id
            LEFT JOIN vehicles v
                ON v.vehicle_id = w.vehicle_id
            LEFT JOIN users u
                ON u.user_id = pr.received_by
            WHERE pr.receipt_id = $1
        `, [req.params.id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'سند القبض غير موجود'
            });
        }

        const receipt = result.rows[0];

        const templatePath = path.join(__dirname, '../../public/Mloktangeed.png');
        const regularFont = '/system/fonts/NotoNaskhArabic-Regular.ttf';
        const boldFont = '/system/fonts/NotoNaskhArabic-Bold.ttf';

        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({
                success: false,
                message: 'قالب سند القبض غير موجود'
            });
        }

        if (!fs.existsSync(regularFont)) {
            return res.status(500).json({
                success: false,
                message: 'خط Noto Naskh Arabic غير موجود'
            });
        }

        const arabicFont = fontkit.openSync(regularFont);
        const arabicBoldFont = fs.existsSync(boldFont)
            ? fontkit.openSync(boldFont)
            : arabicFont;

        function pathToSvg(pathObject) {
            let d = '';

            for (const cmd of pathObject.commands) {
                const a = cmd.args;

                switch (cmd.command) {
                    case 'moveTo':
                        d += `M ${a[0]} ${a[1]} `;
                        break;

                    case 'lineTo':
                        d += `L ${a[0]} ${a[1]} `;
                        break;

                    case 'quadraticCurveTo':
                        d += `Q ${a[0]} ${a[1]} ${a[2]} ${a[3]} `;
                        break;

                    case 'bezierCurveTo':
                        d += `C ${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]} `;
                        break;

                    case 'closePath':
                        d += 'Z ';
                        break;
                }
            }

            return d;
        }

        function addArabicText(doc, text, rightX, baselineY, fontSize, bold = false) {
            text = String(text ?? '').trim();

            if (!text) return;

            const font = bold ? arabicBoldFont : arabicFont;
            const visual = rtlText(text);
            const layout = font.layout(visual);
            const scale = fontSize / font.unitsPerEm;

            let x = rightX;
            let paths = '';

            for (const glyph of layout.glyphs) {
                x -= glyph.advanceWidth * scale;

                // glyph رقم 0 يعني حرف/رمز غير موجود في الخط.
                // تجاهله بدل إظهاره كمربع.
                if (glyph.id === 0) continue;

                paths += `
                    <path
                        d="${pathToSvg(glyph.path)}"
                        transform="translate(${x},${baselineY}) scale(${scale},${-scale})"
                        fill="black"
                    />
                `;
            }

            const svg = `
                <svg xmlns="http://www.w3.org/2000/svg"
                     width="1536"
                     height="1024"
                     viewBox="0 0 1536 1024">
                    ${paths}
                </svg>
            `;

            SVGtoPDF(doc, svg, 0, 0, {
                preserveAspectRatio: 'none'
            });
        }

        function moneyWords(amount) {
            const n = Math.round(Number(amount) || 0);

            const ones = [
                '', 'واحد', 'اثنان', 'ثلاثة', 'أربعة',
                'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'
            ];

            const tens = [
                '', '', 'عشرون', 'ثلاثون', 'أربعون',
                'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'
            ];

            if (n === 0) return 'صفر ريال يمني';

            if (n < 10) return `${ones[n]} ريال يمني`;

            if (n < 20) {
                const teens = {
                    10: 'عشرة',
                    11: 'أحد عشر',
                    12: 'اثنا عشر',
                    13: 'ثلاثة عشر',
                    14: 'أربعة عشر',
                    15: 'خمسة عشر',
                    16: 'ستة عشر',
                    17: 'سبعة عشر',
                    18: 'ثمانية عشر',
                    19: 'تسعة عشر'
                };

                return `${teens[n]} ريال يمني`;
            }

            if (n < 100) {
                const one = n % 10;
                const ten = Math.floor(n / 10);

                if (!one) return `${tens[ten]} ريال يمني`;

                return `${ones[one]} و${tens[ten]} ريال يمني`;
            }

            if (n < 1000) {
                const hundreds = Math.floor(n / 100);
                const rest = n % 100;

                const h = [
                    '', 'مائة', 'مائتان', 'ثلاثمائة',
                    'أربعمائة', 'خمسمائة', 'ستمائة',
                    'سبعمائة', 'ثمانمائة', 'تسعمائة'
                ][hundreds];

                return rest
                    ? `${h} و${moneyWords(rest).replace(' ريال يمني', '')} ريال يمني`
                    : `${h} ريال يمني`;
            }

            return `${n.toLocaleString('en-US')} ريال يمني`;
        }

        function paymentMethodName(method) {
            const map = {
                CASH: 'نقداً',
                CARD: 'بطاقة',
                TRANSFER: 'تحويل بنكي',
                BANK_TRANSFER: 'تحويل بنكي',
                E_WALLET: 'محفظة إلكترونية',
                CHEQUE: 'شيك',
                OTHER: 'أخرى'
            };

            return map[method] || method || 'نقداً';
        }

        const doc = new PDFDocument({
            size: [1536, 1024],
            margin: 0
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `inline; filename="receipt-${receipt.receipt_no}.pdf"`
        );

        doc.pipe(res);

        // القالب الأصلي بالحجم الكامل
        doc.image(templatePath, 0, 0, {
            width: 1536,
            height: 1024
        });

        /*
         * البيانات العربية تُرسم كـ SVG Glyph Paths
         * لتجنب مشكلة المربعات في PDFKit.
         */

        // رقم السند والتاريخ: أرقام لاتينية، لذلك PDFKit العادي يكفي.
        doc.font('Helvetica').fontSize(16);

        doc.text(String(receipt.receipt_no), 55, 325, {
            width: 330,
            align: 'left',
            lineBreak: false
        });

        doc.text(
            new Date(receipt.received_at).toLocaleDateString('en-GB'),
            1160,
            325,
            {
                width: 300,
                align: 'left',
                lineBreak: false
            }
        );

        // استلمنا من الأخ
        addArabicText(
            doc,
            receipt.customer_name,
            800,
            423,
            16
        );

        // المبلغ كتابة
        addArabicText(
            doc,
            moneyWords(receipt.amount),
            800,
            477,
            15
        );

        // وذلك مقابل — العربية منفصلة عن رقم أمر التشغيل والرموز
        addArabicText(
            doc,
            'دفعة عن أمر التشغيل',
            900,
            575,
            15
        );

        // لا نكرر رقم أمر التشغيل أو طريقة الدفع هنا.
        // لكل منهما خانته الخاصة في قالب سند القبض.

        // المبلغ بالأرقام
        doc.font('Helvetica-Bold').fontSize(24);

        doc.text(
            Number(receipt.amount).toLocaleString('en-US'),
            1120,
            477,
            {
                width: 300,
                align: 'left',
                lineBreak: false
            }
        );

        // أمر التشغيل
        doc.font('Helvetica').fontSize(15);

        doc.text(String(receipt.work_order_no), 720, 632, {
            width: 330,
            align: 'left',
            lineBreak: false
        });

        // تاريخ الاستحقاق
        doc.text(
            new Date(receipt.received_at).toLocaleDateString('en-GB'),
            70,
            655,
            {
                width: 300,
                align: 'left',
                lineBreak: false
            }
        );

        // الملاحظات
        if (receipt.notes) {
            addArabicText(
                doc,
                receipt.notes,
                880,
                710,
                14
            );
        }

        // المستلم
        addArabicText(
            doc,
            receipt.customer_name,
            1236,
            860,
            15
        );

        // أمين الصندوق
        addArabicText(
            doc,
            receipt.received_by_username || 'مدير النظام',
            370,
            860,
            15
        );

        doc.end();

    } catch (error) {
        console.error('Generate receipt PDF error:', error);

        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: 'فشل إنشاء PDF سند القبض'
            });
        }
    }
});

module.exports = router;
