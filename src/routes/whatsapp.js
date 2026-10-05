const express = require('express');
const router = express.Router();

const axios = require('axios');
const pool = require('../../db');
const { authenticateToken } = require('../middleware/auth');
const {
    sendTextMessage,
    sendUrlButtonMessage,
    sendContactMessage,
    sendTemplateMessage,
        sendImageMessage,
    saveOutgoingWhatsAppMessage,
    downloadWhatsAppMedia
} = require('../services/whatsapp/whatsapp');

const bookingSessions = new Map();
const WHATSAPP_AUTO_REPLY_ENABLED = true;

const WHATSAPP_API_VERSION =
    process.env.WHATSAPP_API_VERSION || 'v23.0';
const WHATSAPP_PHONE_NUMBER_ID =
    process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ACCESS_TOKEN =
    process.env.WHATSAPP_ACCESS_TOKEN;

async function findEmployeeByWhatsApp(from) {
    const normalized = String(from || '').replace(/\D/g, '');

    const result = await pool.query(
        `
        SELECT
            employee_id,
            employee_no,
            full_name,
            phone,
            is_active
        FROM employees
        WHERE is_active = TRUE
          AND (
              regexp_replace(COALESCE(phone::text, ''), '\D', '', 'g') = $1
              OR regexp_replace(COALESCE(phone::text, ''), '\D', '', 'g') = RIGHT($1, 9)
              OR regexp_replace(COALESCE(phone::text, ''), '\D', '', 'g') = RIGHT($1, 10)
          )
        LIMIT 1
        `,
        [normalized]
    );

    return result.rows[0] || null;
}

async function createEmployeeFinancialTransaction({
    employeeId,
    amount,
    direction,
    description,
    from,
    transactionType = 'ADJUSTMENT',
    workOrderId = null,
    pieceworkId = null
}) {
    const result = await pool.query(
        `
        INSERT INTO employee_financial_transactions (
            employee_id,
            transaction_no,
            transaction_type,
            amount,
            direction,
            work_order_id,
            piecework_id,
            description,
            notes,
            created_by
        )
        VALUES (
            $1,
            NULL,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            NULL
        )
        RETURNING
            transaction_id,
            transaction_no,
            employee_id,
            transaction_type,
            amount,
            direction,
            work_order_id,
            piecework_id,
            description,
            transaction_date
        `,
        [
            employeeId,
            transactionType,
            amount,
            direction,
            workOrderId,
            pieceworkId,
            description || null,
            `WhatsApp: ${from}`
        ]
    );

    return result.rows[0];
}



function parseEmployeeWorkOrderMessage(text) {
    const raw = String(text || '').trim();

    if (!/^#EMP\b/i.test(raw)) {
        return null;
    }

    const body = raw.replace(/^#EMP\s*/i, '').trim();

    const getValue = (label) => {
        const re = new RegExp(
            '^' + label + '\\s*:\\s*(.+)$',
            'im'
        );
        const match = body.match(re);
        return match ? match[1].trim() : '';
    };

    const employee = getValue('الموظف');
    const vehicle = getValue('نوع السيارة');
    const model = getValue('الموديل');
    const yearText = getValue('السنة');
    const work = getValue('العمل');
    const amountText = getValue('المبلغ');
    const date = getValue('التاريخ');

    const amount = Number(
        String(amountText)
            .replace(/,/g, '')
            .replace(/[^\d.]/g, '')
    );

    if (!employee) {
        throw new Error('اسم الموظف مطلوب.');
    }

    if (!vehicle) {
        throw new Error('نوع السيارة مطلوب.');
    }

    if (!model) {
        throw new Error('موديل السيارة مطلوب.');
    }

    const modelYear = Number(yearText);

    if (!Number.isInteger(modelYear) || modelYear < 1900 || modelYear > 2100) {
        throw new Error('سنة السيارة غير صحيحة.');
    }

    if (!work) {
        throw new Error('وصف العمل مطلوب.');
    }

    if (!Number.isFinite(amount) || amount < 0) {
        throw new Error('مبلغ العمل غير صحيح.');
    }

    if (!date) {
        throw new Error('تاريخ العمل مطلوب.');
    }

    const dateMatch = date.match(/^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/);
    if (!dateMatch) {
        throw new Error('صيغة تاريخ العمل يجب أن تكون DD/MM/YYYY مثل 27/09/2026.');
    }

    const [, day, month, year] = dateMatch;
    const workDate = `${year}-${month}-${day}`;

    return {
        employee,
        vehicle,
        model,
        modelYear,
        work,
        amount,
        date,
        workDate
    };
}

function parseNewWorkOrderMessage(text) {
    const raw = String(text || '').trim();

    if (!raw.startsWith('#NEW')) {
        return null;
    }

    const body = raw.replace(/^#NEW\s*/i, '').trim();

    const getSection = (sectionName) => {
        const lines = body.split(/\r?\n/);
        const startIndex = lines.findIndex(line =>
            line.trim().replace(/^\[|\]$/g, '').trim() === sectionName
        );

        if (startIndex === -1) {
            return '';
        }

        const result = [];

        for (let i = startIndex + 1; i < lines.length; i++) {
            const line = lines[i].trim();

            if (
                /^\[[^\]]+\]$/.test(line)
            ) {
                break;
            }

            result.push(lines[i]);
        }

        return result.join('\n').trim();
    };

    const getHeader = () => {
        const lines = body.split(/\r?\n/);
        const result = [];

        for (const line of lines) {
            if (/^\[[^\]]+\]$/.test(line.trim())) {
                break;
            }

            result.push(line);
        }

        return result.join('\n').trim();
    };

    const getField = (section, label) => {
        const lines = section.split(/\r?\n/);

        const line = lines.find(item => {
            const match = item.match(
                new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, 'i')
            );

            return !!match;
        });

        if (!line) {
            return '';
        }

        const match = line.match(
            new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, 'i')
        );

        return match ? match[1].trim() : '';
    };

    const parseMoney = (value) => {
        const cleaned = String(value || '')
            .replace(/,/g, '')
            .replace(/،/g, '')
            .replace(/[^\d.]/g, '');

        if (!cleaned) {
            return 0;
        }

        const number = Number(cleaned);

        return Number.isFinite(number) && number >= 0
            ? number
            : null;
    };

    const header = getHeader();
    const details = getSection('التفاصيل');
    const work = getSection('العمل');
    const account = getSection('الحساب');

    const customerName = getField(header, 'العميل');
    const phone = getField(header, 'الجوال');
    const vehicleRaw = getField(header, 'السيارة');

    const services = {
        seats: parseMoney(getField(work, 'المقاعد')),
        floor: parseMoney(getField(work, 'الفرشة الأرضية')),
        doors: parseMoney(getField(work, 'الأبواب')),
        dashboard: parseMoney(getField(work, 'الطبلون')),
        steering: parseMoney(getField(work, 'خياط السكان')),
        roof: parseMoney(getField(work, 'السقف')),
        other: parseMoney(getField(work, 'أخرى'))
    };

    for (const [key, value] of Object.entries(services)) {
        if (value === null) {
            throw new Error(`قيمة غير صحيحة للخدمة: ${key}`);
        }
    }

    const discount = parseMoney(getField(account, 'الخصم'));
    const deposit = parseMoney(getField(account, 'العربون'));

    if (discount === null || deposit === null) {
        throw new Error('الخصم أو العربون غير صحيح.');
    }

    if (!customerName) {
        throw new Error('حقل العميل مفقود.');
    }

    if (!phone) {
        throw new Error('حقل الجوال مفقود.');
    }

    if (!vehicleRaw) {
        throw new Error('حقل السيارة مفقود.');
    }

    const yearMatch = vehicleRaw.match(/\b(19|20)\d{2}\b/);

    const modelYear = yearMatch
        ? Number(yearMatch[0])
        : null;

    const vehicleWithoutYear = vehicleRaw
        .replace(/\b(19|20)\d{2}\b/, '')
        .replace(/\s+/g, ' ')
        .trim();

    const vehicleParts = vehicleWithoutYear.split(/\s+/);

    const make = vehicleParts.shift() || '';
    const model = vehicleParts.join(' ');

    return {
        customer: {
            fullName: customerName,
            phone
        },

        vehicle: {
            raw: vehicleRaw,
            make,
            model,
            modelYear
        },

        details: {
            leather: getField(details, 'الجلد'),
            colors: getField(details, 'الألوان'),
            thread: getField(details, 'الخيط'),
            design: getField(details, 'التصميم')
        },

        services,
        discount,
        deposit
    };
}




async function updateWorkOrderStageFromWhatsApp(orderNo, stageText) {
    const normalizedOrderNo = String(orderNo || '').trim().toUpperCase();
    const normalizedStage = String(stageText || '').trim();

    const stageMap = {
        'تم استلام السيارة': 'استقبال العميل',
        'تمت المعاينة': 'معاينة السيارة',
        'تم تحديد الطلب': 'تحديد طلب العميل',
        'تم اعتماد التصميم': 'اعتماد التصميم والخامات والسعر',
        'بدأ التنفيذ': 'التنفيذ',
        'تم الفحص أثناء العمل': 'الفحص أثناء العمل',
        'تم الفحص النهائي': 'الفحص النهائي',
        'يحتاج تصحيح': 'التصحيح عند الحاجة',
        'جاهز للتسليم': 'جاهز للتسليم',
        'تم التسليم': 'التسليم',
        'تم إغلاق الأمر': 'إغلاق أمر العمل'
    };

    const stageName = stageMap[normalizedStage];

    if (!stageName) {
        throw new Error('المرحلة غير مدعومة حاليًا.');
    }

    const orderResult = await pool.query(
        `
        SELECT
            wo.work_order_id,
            wo.work_order_no,
            c.full_name AS customer_name,
            c.phone AS customer_phone
        FROM work_orders wo
        JOIN customers c
            ON c.customer_id = wo.customer_id
        WHERE UPPER(wo.work_order_no) = $1
        LIMIT 1
        `,
        [normalizedOrderNo]
    );

    if (!orderResult.rows.length) {
        throw new Error('رقم أمر التشغيل غير موجود.');
    }

    const workOrder = orderResult.rows[0];

    const stageResult = await pool.query(
        `
        SELECT stage_id, stage_name, status
        FROM work_order_stages
        WHERE work_order_id = $1
          AND stage_name = $2
        LIMIT 1
        `,
        [workOrder.work_order_id, stageName]
    );

    if (!stageResult.rows.length) {
        throw new Error('مرحلة أمر التشغيل غير موجودة.');
    }

    const stage = stageResult.rows[0];

    const updatedResult = await pool.query(
        `
        UPDATE work_order_stages
        SET
            status = 'COMPLETED',
            started_at = COALESCE(started_at, NOW()),
            completed_at = NOW()
        WHERE stage_id = $1
          AND work_order_id = $2
        RETURNING
            stage_id,
            stage_name,
            status,
            started_at,
            completed_at
        `,
        [stage.stage_id, workOrder.work_order_id]
    );

    return {
        workOrderNo: workOrder.work_order_no,
        customerName: workOrder.customer_name,
        customerPhone: workOrder.customer_phone,
        stage: updatedResult.rows[0]
    };
}


async function getWorkOrderForCustomer(orderNo, phone) {
    const normalizedOrderNo = String(orderNo || '').trim().toUpperCase();
    const phoneDigits = String(phone || '').replace(/\D/g, '');
    const phoneLast9 = phoneDigits.slice(-9);

    if (!normalizedOrderNo || !phoneLast9) {
        return null;
    }

    const result = await pool.query(
        `
        SELECT
            wo.work_order_id,
            wo.work_order_no,
            wo.status,
            wo.subtotal,
            wo.discount_amount,
            wo.total_amount,
            wo.deposit_amount,
            wo.balance_amount,
            c.full_name AS customer_name,
            c.phone AS customer_phone,
            v.make,
            v.model,
            v.model_year,
            ws.stage_name AS current_stage
        FROM work_orders wo
        JOIN customers c
            ON c.customer_id = wo.customer_id
        LEFT JOIN vehicles v
            ON v.vehicle_id = wo.vehicle_id
        LEFT JOIN LATERAL (
            SELECT stage_name
            FROM work_order_stages
            WHERE work_order_id = wo.work_order_id
              AND status = 'IN_PROGRESS'
            ORDER BY stage_order
            LIMIT 1
        ) ws ON TRUE
        WHERE UPPER(wo.work_order_no) = $1
          AND (
              regexp_replace(COALESCE(c.phone::text, ''), '\\D', '', 'g') = $2
              OR RIGHT(
                  regexp_replace(COALESCE(c.phone::text, ''), '\\D', '', 'g'),
                  9
              ) = $3
          )
        LIMIT 1
        `,
        [normalizedOrderNo, phoneDigits, phoneLast9]
    );

    return result.rows[0] || null;
}


async function findEmployeeForEmployeeOrder(employeeText) {
    const search = String(employeeText || '').trim();

    if (!search) {
        throw new Error('اسم الموظف مطلوب.');
    }

    const result = await pool.query(
        `
        SELECT employee_id, employee_no, full_name
        FROM employees
        WHERE is_active = TRUE
          AND (
              LOWER(full_name) = LOWER($1)
              OR LOWER(full_name) LIKE LOWER($2)
          )
        ORDER BY
            CASE
                WHEN LOWER(full_name) = LOWER($1) THEN 0
                ELSE 1
            END,
            employee_id
        `,
        [search, `%${search}%`]
    );

    if (!result.rows.length) {
        throw new Error(`لم يتم العثور على موظف باسم: ${search}`);
    }

    if (result.rows.length > 1) {
        const names = result.rows
            .map(row => `${row.full_name} (${row.employee_no})`)
            .join('\n');

        throw new Error(
            `وجدت أكثر من موظف مطابق لـ "${search}":\n${names}\n\n` +
            `اكتب الاسم بشكل أوضح.`
        );
    }

    return result.rows[0];
}

async function createEmployeeWorkOrder(data, employee) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const internalCustomerName = `عمل داخلي - ${employee.full_name}`;

        let customerResult = await client.query(
            `
            SELECT customer_id, customer_no, full_name, phone
            FROM customers
            WHERE full_name = $1
            ORDER BY customer_id
            LIMIT 1
            `,
            [internalCustomerName]
        );

        let customer;

        if (customerResult.rows.length) {
            customer = customerResult.rows[0];
        } else {
            const result = await client.query(
                `
                INSERT INTO customers (full_name, phone)
                VALUES ($1, 'INTERNAL-EMPLOYEE')
                RETURNING customer_id, customer_no, full_name, phone
                `,
                [internalCustomerName]
            );

            customer = result.rows[0];
        }

        let vehicleResult = await client.query(
            `
            SELECT vehicle_id, customer_id, make, model, model_year
            FROM vehicles
            WHERE customer_id = $1
              AND LOWER(COALESCE(make, '')) = LOWER($2)
              AND LOWER(COALESCE(model, '')) = LOWER($3)
              AND model_year = $4
            ORDER BY vehicle_id DESC
            LIMIT 1
            `,
            [
                customer.customer_id,
                data.vehicle,
                data.model,
                data.modelYear
            ]
        );

        let vehicle;

        if (vehicleResult.rows.length) {
            vehicle = vehicleResult.rows[0];
        } else {
            const result = await client.query(
                `
                INSERT INTO vehicles (
                    customer_id,
                    make,
                    model,
                    model_year
                )
                VALUES ($1, $2, $3, $4)
                RETURNING vehicle_id, customer_id, make, model, model_year
                `,
                [
                    customer.customer_id,
                    data.vehicle,
                    data.model,
                    data.modelYear
                ]
            );

            vehicle = result.rows[0];
        }

        const workOrderResult = await client.query(
            `
            INSERT INTO work_orders (
                branch_id,
                customer_id,
                vehicle_id,
                created_by,
                assigned_to,
                status,
                priority,
                received_at,
                customer_notes,
                internal_notes,
                subtotal,
                discount_amount,
                tax_amount,
                total_amount,
                deposit_amount
            )
            VALUES (
                1,
                $1,
                $2,
                1,
                $3,
                'NEW',
                'NORMAL',
                $4::timestamptz,
                $5,
                $6,
                $7,
                0,
                0,
                $7,
                0
            )
            RETURNING
                work_order_id,
                work_order_no,
                customer_id,
                vehicle_id,
                assigned_to,
                total_amount
            `,
            [
                customer.customer_id,
                vehicle.vehicle_id,
                employee.employee_id,
                data.workDate,
                `أمر تشغيل داخلي للموظف: ${employee.full_name}`,
                `نوع الأمر: عمل موظف\nالعمل: ${data.work}`,
                data.amount
            ]
        );

        const workOrder = workOrderResult.rows[0];

        const stages = [
            'استقبال العميل',
            'معاينة السيارة',
            'تحديد طلب العميل',
            'اعتماد التصميم والخامات والسعر',
            'التنفيذ',
            'الفحص أثناء العمل',
            'الفحص النهائي',
            'التصحيح عند الحاجة',
            'جاهز للتسليم',
            'التسليم',
            'إغلاق أمر العمل'
        ];

        for (let i = 0; i < stages.length; i++) {
            await client.query(
                `
                INSERT INTO work_order_stages (
                    work_order_id,
                    stage_name,
                    stage_order,
                    status
                )
                VALUES ($1, $2, $3, 'PENDING')
                ON CONFLICT (work_order_id, stage_order)
                DO NOTHING
                `,
                [
                    workOrder.work_order_id,
                    stages[i],
                    i + 1
                ]
            );
        }

        const executionStageResult = await client.query(
            `SELECT stage_id
             FROM work_order_stages
             WHERE work_order_id = $1
               AND stage_order = 5
             LIMIT 1`,
            [workOrder.work_order_id]
        );

        const executionStageId =
            executionStageResult.rows[0]?.stage_id || null;

        await client.query(
            `INSERT INTO employee_piecework (
                work_order_id,
                employee_id,
                stage_id,
                work_description,
                amount,
                status,
                notes
            )
            VALUES ($1, $2, $3, $4, $5, 'DUE', $6)`,
            [
                workOrder.work_order_id,
                employee.employee_id,
                executionStageId,
                data.work,
                data.amount,
                `أمر تشغيل موظف عبر WhatsApp - ${employee.full_name}`
            ]
        );

        await client.query('COMMIT');

        return {
            ...workOrder,
            employeeName: employee.full_name,
            employeeNo: employee.employee_no,
            vehicle,
            work: data.work,
            amount: data.amount,
            workDate: data.date
        };

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function createWorkOrderFromWhatsApp(data) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const phoneDigits = String(data.customer.phone || '')
            .replace(/\D/g, '');

        const phoneLast9 = phoneDigits.slice(-9);

        // البحث عن العميل برقم الجوال، سواء كان محفوظًا محليًا أو دوليًا
        let customerResult = await client.query(
            `
            SELECT customer_id, customer_no, full_name, phone
            FROM customers
            WHERE regexp_replace(COALESCE(phone::text, ''), '\D', '', 'g') = $1
               OR RIGHT(regexp_replace(COALESCE(phone::text, ''), '\D', '', 'g'), 9) = $2
            ORDER BY customer_id DESC
            LIMIT 1
            `,
            [phoneDigits, phoneLast9]
        );

        let customer;

        if (customerResult.rows.length) {
            customer = customerResult.rows[0];

            await client.query(
                `
                UPDATE customers
                SET
                    full_name = $1,
                    phone = $2,
                    updated_at = CURRENT_TIMESTAMP
                WHERE customer_id = $3
                `,
                [
                    data.customer.fullName,
                    data.customer.phone,
                    customer.customer_id
                ]
            );
        } else {
            const result = await client.query(
                `
                INSERT INTO customers (
                    full_name,
                    phone
                )
                VALUES ($1, $2)
                RETURNING customer_id, customer_no, full_name, phone
                `,
                [
                    data.customer.fullName,
                    data.customer.phone
                ]
            );

            customer = result.rows[0];
        }

        // البحث عن سيارة مشابهة للعميل أولًا
        let vehicleResult = await client.query(
            `
            SELECT
                vehicle_id,
                customer_id,
                plate_no,
                make,
                model,
                model_year
            FROM vehicles
            WHERE customer_id = $1
              AND LOWER(COALESCE(make, '')) = LOWER($2)
              AND LOWER(COALESCE(model, '')) = LOWER($3)
              AND (
                  model_year = $4
                  OR (model_year IS NULL AND $4 IS NULL)
              )
            ORDER BY vehicle_id DESC
            LIMIT 1
            `,
            [
                customer.customer_id,
                data.vehicle.make,
                data.vehicle.model,
                data.vehicle.modelYear
            ]
        );

        let vehicle;

        if (vehicleResult.rows.length) {
            vehicle = vehicleResult.rows[0];
        } else {
            const result = await client.query(
                `
                INSERT INTO vehicles (
                    customer_id,
                    make,
                    model,
                    model_year
                )
                VALUES ($1, $2, $3, $4)
                RETURNING
                    vehicle_id,
                    customer_id,
                    plate_no,
                    make,
                    model,
                    model_year
                `,
                [
                    customer.customer_id,
                    data.vehicle.make || null,
                    data.vehicle.model || null,
                    data.vehicle.modelYear || null
                ]
            );

            vehicle = result.rows[0];
        }

        const serviceRows = [
            {
                serviceCode: 'UPH-002',
                amount: data.services.seats,
                note: null
            },
            {
                serviceCode: 'UPH-003',
                amount: data.services.floor,
                note: null
            },
            {
                serviceCode: 'UPH-006',
                amount: data.services.doors,
                note: null
            },
            {
                serviceCode: 'UPH-005',
                amount: data.services.dashboard,
                note: null
            },
            {
                serviceCode: 'UPH-004',
                amount: data.services.roof,
                note: null
            },
            {
                serviceCode: 'UPH-007',
                amount: data.services.steering,
                note: 'خياط السكان'
            },
            {
                serviceCode: 'UPH-007',
                amount: data.services.other,
                note: 'أعمال أخرى'
            }
        ].filter(item => Number(item.amount) > 0);

        const subtotal = serviceRows.reduce(
            (sum, item) => sum + Number(item.amount),
            0
        );

        const discount = Number(data.discount || 0);
        const deposit = Number(data.deposit || 0);
        const total = subtotal - discount;

        if (discount > subtotal) {
            throw new Error('الخصم أكبر من إجمالي الخدمات.');
        }

        if (deposit > total) {
            throw new Error('العربون أكبر من إجمالي أمر التشغيل.');
        }

        const requirements =
            `الجلد: ${data.details.leather || 'غير محدد'}\n` +
            `الألوان: ${data.details.colors || 'غير محدد'}\n` +
            `الخيط: ${data.details.thread || 'غير محدد'}\n` +
            `التصميم: ${data.details.design || 'غير محدد'}`;

        const workOrderResult = await client.query(
            `
            INSERT INTO work_orders (
                branch_id,
                customer_id,
                vehicle_id,
                created_by,
                status,
                priority,
                received_at,
                customer_notes,
                subtotal,
                discount_amount,
                tax_amount,
                total_amount,
                deposit_amount
            )
            VALUES (
                1,
                $1,
                $2,
                1,
                'NEW',
                'NORMAL',
                CURRENT_TIMESTAMP,
                $3,
                $4,
                $5,
                0,
                $6,
                $7
            )
            RETURNING
                work_order_id,
                work_order_no,
                customer_id,
                vehicle_id,
                subtotal,
                discount_amount,
                total_amount,
                deposit_amount,
                balance_amount
            `,
            [
                customer.customer_id,
                vehicle.vehicle_id,
                'تم إنشاء أمر التشغيل عبر WhatsApp\n' + requirements,
                subtotal,
                discount,
                total,
                deposit
            ]
        );

        const workOrder = workOrderResult.rows[0];

        for (const item of serviceRows) {
            const serviceResult = await client.query(
                `
                SELECT service_id
                FROM services
                WHERE service_code = $1
                  AND is_active = TRUE
                LIMIT 1
                `,
                [item.serviceCode]
            );

            if (!serviceResult.rows.length) {
                throw new Error(
                    `الخدمة غير موجودة: ${item.serviceCode}`
                );
            }

            await client.query(
                `
                INSERT INTO work_order_services (
                    work_order_id,
                    service_id,
                    quantity,
                    unit_price,
                    discount,
                    notes
                )
                VALUES ($1, $2, 1, $3, 0, $4)
                `,
                [
                    workOrder.work_order_id,
                    serviceResult.rows[0].service_id,
                    item.amount,
                    item.note
                ]
            );
        }

        await client.query(
            `
            INSERT INTO vehicle_inspections (
                work_order_id,
                inspection_type,
                result,
                customer_requirements,
                inspected_at
            )
            VALUES (
                $1,
                'INITIAL',
                'PENDING',
                $2,
                CURRENT_TIMESTAMP
            )
            `,
            [
                workOrder.work_order_id,
                requirements
            ]
        );

        const stages = [
            'استقبال العميل',
            'معاينة السيارة',
            'تحديد طلب العميل',
            'اعتماد التصميم والخامات والسعر',
            'التنفيذ',
            'الفحص أثناء العمل',
            'الفحص النهائي',
            'التصحيح عند الحاجة',
            'جاهز للتسليم',
            'التسليم',
            'إغلاق أمر العمل'
        ];

        for (let i = 0; i < stages.length; i++) {
            await client.query(
                `
                INSERT INTO work_order_stages (
                    work_order_id,
                    stage_name,
                    stage_order,
                    status
                )
                VALUES ($1, $2, $3, 'PENDING')
                ON CONFLICT (work_order_id, stage_order)
                DO NOTHING
                `,
                [
                    workOrder.work_order_id,
                    stages[i],
                    i + 1
                ]
            );
        }

        await client.query('COMMIT');

        return {
            ...workOrder,
            customerName: data.customer.fullName,
            customerPhone: data.customer.phone,
            vehicle: data.vehicle,
            requirements,
            subtotal,
            discount,
            total,
            deposit,
            balance: Math.max(total - deposit, 0)
        };

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/*
|--------------------------------------------------------------------------
| WhatsApp Chat API — لوحة ملوك التنجيد
|--------------------------------------------------------------------------
*/

router.get('/conversations', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                wa_id,
                customer_name,
                last_message_text,
                unread_count,
                last_message_at,
                updated_at
            FROM whatsapp_conversations
            ORDER BY
                last_message_at DESC NULLS LAST,
                id DESC
        `);

        res.json({
            success: true,
            conversations: result.rows
        });
    } catch (error) {
        console.error('WhatsApp conversations API error:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر تحميل المحادثات'
        });
    }
});

router.get('/conversations/:id/messages', authenticateToken, async (req, res) => {
    try {
        const conversationId = Number(req.params.id);

        if (!Number.isInteger(conversationId)) {
            return res.status(400).json({
                success: false,
                message: 'معرف المحادثة غير صحيح'
            });
        }

        const conversation = await pool.query(`
            SELECT
                id,
                wa_id,
                customer_name,
                last_message_text,
                unread_count,
                last_message_at
            FROM whatsapp_conversations
            WHERE id = $1
        `, [conversationId]);

        if (!conversation.rows.length) {
            return res.status(404).json({
                success: false,
                message: 'المحادثة غير موجودة'
            });
        }

        const messages = await pool.query(`
            SELECT
                id,
                whatsapp_message_id,
                direction,
                message_type,
                message_text,
                status,
                created_at
            FROM whatsapp_messages
            WHERE conversation_id = $1
            ORDER BY created_at ASC, id ASC
        `, [conversationId]);

        await pool.query(`
            UPDATE whatsapp_conversations
            SET unread_count = 0,
                updated_at = NOW()
            WHERE id = $1
        `, [conversationId]);

        res.json({
            success: true,
            conversation: conversation.rows[0],
            messages: messages.rows
        });
    } catch (error) {
        console.error('WhatsApp messages API error:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر تحميل الرسائل'
        });
    }
});

router.get('/conversations/:id/bookings', authenticateToken, async (req, res) => {
    try {
        const conversationId = Number(req.params.id);

        const conversation = await pool.query(`
            SELECT wa_id
            FROM whatsapp_conversations
            WHERE id = $1
        `, [conversationId]);

        if (!conversation.rows.length) {
            return res.status(404).json({
                success: false,
                message: 'المحادثة غير موجودة'
            });
        }

        const result = await pool.query(`
            SELECT
                id,
                booking_no,
                car_type,
                model_year,
                service,
                branch,
                booking_day,
                booking_time,
                booking_date,
                status,
                payment_proof_media_id,
                payment_proof_received_at,
                payment_proof_status,
                created_at
            FROM whatsapp_bookings
            WHERE whatsapp_from = $1
            ORDER BY created_at DESC, id DESC
        `, [conversation.rows[0].wa_id]);

        res.json({
            success: true,
            bookings: result.rows
        });
    } catch (error) {
        console.error('WhatsApp bookings API error:', error);
        res.status(500).json({
            success: false,
            message: 'تعذر تحميل الحجوزات'
        });
    }
});


router.get('/bookings/:id/payment-proof', authenticateToken, async (req, res) => {
    try {
        const bookingId = Number(req.params.id);

        if (!Number.isInteger(bookingId)) {
            return res.status(400).json({
                success: false,
                message: 'معرف الحجز غير صحيح'
            });
        }

        const result = await pool.query(
            `
            SELECT
                booking_no,
                payment_proof_media_id,
                payment_proof_status
            FROM whatsapp_bookings
            WHERE id = $1
            LIMIT 1
            `,
            [bookingId]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                success: false,
                message: 'الحجز غير موجود'
            });
        }

        const booking = result.rows[0];

        if (!booking.payment_proof_media_id) {
            return res.status(404).json({
                success: false,
                message: 'لا يوجد إثبات تحويل لهذا الحجز'
            });
        }

        const path = require('path');

        const filePath = path.join(
            process.cwd(),
            'storage',
            'whatsapp-payment-proofs',
            `${booking.booking_no}-${booking.payment_proof_media_id}.jpg`
        );

        return res.sendFile(filePath, {
            headers: {
                'Cache-Control': 'private, no-store'
            }
        });
    } catch (error) {
        console.error(
            'WhatsApp payment proof API error:',
            error.message
        );

        res.status(500).json({
            success: false,
            message: 'تعذر عرض إثبات التحويل'
        });
    }
});

router.post('/bookings/:id/confirm-payment', authenticateToken, async (req, res) => {
    try {
        const bookingId = Number(req.params.id);

        if (!Number.isInteger(bookingId)) {
            return res.status(400).json({
                success: false,
                message: 'معرف الحجز غير صحيح'
            });
        }

        const result = await pool.query(
            `
            UPDATE whatsapp_bookings
            SET
                payment_proof_status = 'CONFIRMED'
            WHERE id = $1
              AND status = 'PENDING_DEPOSIT'
              AND payment_proof_status = 'PENDING_REVIEW'
            RETURNING
                id,
                booking_no,
                whatsapp_from,
                car_type,
                model_year,
                service,
                booking_day,
                booking_date,
                status
            `,
            [bookingId]
        );

        if (!result.rows.length) {
            return res.status(400).json({
                success: false,
                message: 'الحجز غير موجود أو لا يوجد إثبات تحويل بانتظار المراجعة'
            });
        }

        const booking = result.rows[0];

        bookingSessions.set(booking.whatsapp_from, {
            step: 'DAY',
            pendingBookingId: booking.id,
            pendingBookingNo: booking.booking_no
        });

        await sendTextMessage(
            booking.whatsapp_from,
            '✅ *تم اعتماد العربون* 👑\n\n' +
            `🔢 *رقم الطلب:* ${booking.booking_no}\n` +
            `🚗 *السيارة:* ${booking.car_type || ''}\n` +
            `🚘 *الموديل:* ${booking.model_year || ''}\n\n` +
            '💳 تم اعتماد إشعار التحويل بنجاح.\n\n' +
            '📅 الآن اختر اليوم المناسب لك من المواعيد المتاحة أدناه.\n\n' +
            '⚠️ سيتم تثبيت الحجز بعد اختيار الموعد.'
        );

        await sendAvailableDaysMenu(booking.whatsapp_from);

        res.json({
            success: true,
            booking
        });
    } catch (error) {
        console.error(
            'WhatsApp booking payment confirmation error:',
            error.message
        );

        res.status(500).json({
            success: false,
            message: 'تعذر تأكيد الحجز'
        });
    }
});

router.post('/conversations/:id/messages', authenticateToken, async (req, res) => {
    try {
        const conversationId = Number(req.params.id);
        const message = String(req.body?.message || '').trim();

        if (!Number.isInteger(conversationId)) {
            return res.status(400).json({
                success: false,
                message: 'معرف المحادثة غير صحيح'
            });
        }

        if (!message) {
            return res.status(400).json({
                success: false,
                message: 'اكتب رسالة أولًا'
            });
        }

        const conversation = await pool.query(`
            SELECT wa_id
            FROM whatsapp_conversations
            WHERE id = $1
        `, [conversationId]);

        if (!conversation.rows.length) {
            return res.status(404).json({
                success: false,
                message: 'المحادثة غير موجودة'
            });
        }

        const to = conversation.rows[0].wa_id;

        const result = await sendTextMessage(to, message);

        res.json({
            success: true,
            message: 'تم إرسال الرسالة',
            whatsapp: result
        });
    } catch (error) {
        console.error(
            'WhatsApp dashboard send error:',
            JSON.stringify(
                error.response?.data || error.message,
                null,
                2
            )
        );

        res.status(500).json({
            success: false,
            message:
                error.response?.data?.error?.message ||
                error.message ||
                'تعذر إرسال الرسالة'
        });
    }
});


const VERIFY_TOKEN =
    process.env.WHATSAPP_VERIFY_TOKEN || 'muluk_whatsapp_verify_2026';

const DAILY_CAPACITY = Number(
    process.env.WHATSAPP_DAILY_CAPACITY || 2
);

const WHATSAPP_FLOW_ID = process.env.WHATSAPP_FLOW_ID || '2832867003759412';

const BRANCHES = [
    'الفرع الرئيسي'
];

/*
|--------------------------------------------------------------------------
| كتالوج ملوك التنجيد
|--------------------------------------------------------------------------
*/

const CATALOG = {
    sedan: {
        name: 'سيدان — مرحلتان (صف أمام + صف وسط)',
        shortName: 'سيدان — مرحلتان',
        services: {
            seats: {
                name: 'تنجيد المقاعد',
                variants: [
                    {
                        id: 'seats_german',
                        name: '🇩🇪 ألماني',
                        price: 75000,
                        specs: 'جلود بمواصفات ألمانية عازلة للحرارة، سماكة 1 مم',
                        warranty: '5 سنوات'
                    },
                    {
                        id: 'seats_american',
                        name: '🇺🇸 أمريكي',
                        price: 60000,
                        specs: 'جلد بمواصفات أمريكية، سماكة 0.9 مم',
                        warranty: '3 سنوات'
                    },
                    {
                        id: 'seats_european',
                        name: '🇪🇺 أوروبي',
                        price: 45000,
                        specs: 'جلد بمواصفات أوروبية، سماكة 0.6 مم',
                        warranty: 'سنة واحدة'
                    }
                ]
            },

            floor: {
                name: 'تنجيد فرشة الأرضية',
                variants: [
                    {
                        id: 'floor_mtc',
                        name: '⭐ MTC ممتاز',
                        price: 25000,
                        specs: 'فرشة MTC ممتازة'
                    },
                    {
                        id: 'floor_american',
                        name: '🇺🇸 أمريكي ممتاز',
                        price: 20000,
                        specs: 'فرشة أمريكية ممتازة'
                    },
                    {
                        id: 'floor_abu_shaar',
                        name: '🧶 أبو شعرة',
                        price: 15000,
                        specs: 'فرشة أبو شعرة'
                    }
                ]
            },

            full_interior: {
                name: '👑 تغيير داخلي كامل',
                variants: [
                    {
                        id: 'full_interior',
                        name: '👑 تغيير داخلي كامل',
                        price: 180000,
                        specs:
                            'أرقى خامات الجلود + خامات ألمانية + رش الديكورات بأفضل المواد',
                        warranty: '5 سنوات'
                    }
                ]
            },

            roof: {
                name: 'تنجيد السقف',
                variants: [
                    {
                        id: 'roof_kantara',
                        name: '⭐ كنتارا ممتاز',
                        price: 35000,
                        specs: 'مخمل كنتارا ممتاز'
                    },
                    {
                        id: 'roof_patterned',
                        name: '🔹 مخمل مشجر',
                        price: 25000,
                        specs: 'مخمل مشجر'
                    }
                ]
            },

            decor: {
                name: 'رش الديكورات',
                variants: [
                    {
                        id: 'decor_german',
                        name: '🇩🇪 رش ديكورات',
                        price: 35000,
                        specs: 'رنج سيارات بمواصفات ألمانية',
                        warranty: '4 سنوات'
                    }
                ]
            },

            dashboard: {
                name: 'فرش الطبلون',
                variants: [
                    {
                        id: 'dashboard_luxury',
                        name: '👑 ملكي',
                        price: 6000,
                        specs: 'فرش طبلون ملكي'
                    },
                    {
                        id: 'dashboard_normal',
                        name: 'عادي',
                        price: 4000,
                        specs: 'فرش طبلون عادي'
                    }
                ]
            }
        }
    },

    suv: {
        name: 'دفع رباعي — ثلاث مراحل (3 صفوف)',
        shortName: 'دفع رباعي — 3 مراحل',
        services: {
            seats: {
                name: 'تنجيد المقاعد',
                variants: [
                    {
                        id: 'seats_german',
                        name: '🇩🇪 ألماني',
                        price: 150000,
                        specs: 'جلود بمواصفات ألمانية عازلة للحرارة، سماكة 1 مم',
                        warranty: '5 سنوات'
                    },
                    {
                        id: 'seats_american',
                        name: '🇺🇸 أمريكي',
                        price: 90000,
                        specs: 'جلد بمواصفات أمريكية، سماكة 0.9 مم',
                        warranty: '3 سنوات'
                    },
                    {
                        id: 'seats_european',
                        name: '🇪🇺 أوروبي',
                        price: 75000,
                        specs: 'جلد بمواصفات أوروبية، سماكة 0.6 مم',
                        warranty: 'سنة واحدة'
                    }
                ]
            },

            floor: {
                name: 'تنجيد فرشة الأرضية',
                variants: [
                    {
                        id: 'floor_mtc',
                        name: '⭐ MTC ممتاز',
                        price: 35000,
                        specs: 'فرشة MTC ممتازة'
                    },
                    {
                        id: 'floor_american',
                        name: '🇺🇸 أمريكي ممتاز',
                        price: 28000,
                        specs: 'فرشة أمريكية ممتازة'
                    },
                    {
                        id: 'floor_abu_shaar',
                        name: '🧶 أبو شعرة',
                        price: 20000,
                        specs: 'فرشة أبو شعرة'
                    }
                ]
            },

            full_interior: {
                name: '👑 تغيير داخلي كامل',
                variants: [
                    {
                        id: 'full_interior',
                        name: '👑 تغيير داخلي كامل',
                        price: 250000,
                        specs:
                            'أرقى خامات الجلود + خامات ألمانية + رش الديكورات بأفضل المواد',
                        warranty: '5 سنوات'
                    }
                ]
            },

            roof: {
                name: 'تنجيد السقف',
                variants: [
                    {
                        id: 'roof_kantara',
                        name: '⭐ كنتارا ممتاز',
                        price: 45000,
                        specs: 'مخمل كنتارا ممتاز'
                    },
                    {
                        id: 'roof_patterned',
                        name: '🔹 مخمل مشجر',
                        price: 30000,
                        specs: 'مخمل مشجر'
                    }
                ]
            },

            decor: {
                name: 'رش الديكورات',
                variants: [
                    {
                        id: 'decor_german',
                        name: '🇩🇪 رش ديكورات',
                        price: 40000,
                        specs: 'رنج سيارات بمواصفات ألمانية',
                        warranty: '4 سنوات'
                    }
                ]
            },

            dashboard: {
                name: 'فرش الطبلون',
                variants: [
                    {
                        id: 'dashboard_luxury',
                        name: '👑 ملكي',
                        price: 6000,
                        specs: 'فرش طبلون ملكي'
                    },
                    {
                        id: 'dashboard_normal',
                        name: 'عادي',
                        price: 4000,
                        specs: 'فرش طبلون عادي'
                    }
                ]
            }
        }
    }
};


const OFFER_CARS = {
  camry: 'كامري',
  corolla: 'كورولا',
  elantra: 'إلنترا',
  accent: 'أكسنت',
  yaris: 'يارس',
  rav4: 'راف فور',
  hilux: 'هيلوكس',
  sonata: 'سوناتا',
  tucson: 'توسان',
  santafe: 'سنتافي',
  sportage: 'سبورتاج',
  pride: 'برايد',
  kia_lucca: 'كيا لوتشي',
  legend: 'الأسطورة',
  grand_vitara: 'فيتارا جراند',
  matiz: 'ماتيز',
  other: 'أخرى'
};

const OFFER_GOVERNORATES = {
  amanat_alasima: 'أمانة العاصمة',
  sanaa: 'صنعاء',
  aden: 'عدن',
  taiz: 'تعز',
  ibb: 'إب',
  hodeidah: 'الحديدة',
  hadramout: 'حضرموت',
  marib: 'مأرب',
  dhamar: 'ذمار',
  al_bayda: 'البيضاء',
  lahj: 'لحج',
  abyan: 'أبين',
  shabwah: 'شبوة',
  saada: 'صعدة',
  hajjah: 'حجة',
  amran: 'عمران',
  al_mahwit: 'المحويت',
  raymah: 'ريمة',
  al_jawf: 'الجوف',
  al_dhale: 'الضالع',
  al_mahrah: 'المهرة',
  socotra: 'سقطرى'
};

const OFFER_SERVICES = {
  seats: { name: 'تنجيد المقاعد', price: 40000 },
  floor: { name: 'فرشة الأرضية رقم واحد', price: 18999 },
  royal_dashboard: { name: 'فرشة الطبلون الملكي', price: 3999 },
  normal_dashboard: { name: 'فرشة الديكور العادي', price: 2999 }
};

const SERVICE_ORDER = [
    'seats',
    'floor',
    'full_interior',
    'roof',
    'decor',
    'dashboard'
];

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[إأآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .trim();
}

function dateKey(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

function getTodayInYemen() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Aden',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());

    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;

    return new Date(`${year}-${month}-${day}T00:00:00Z`);
}

function formatArabicDate(date) {
    return new Intl.DateTimeFormat('ar-YE', {
        timeZone: 'Asia/Aden',
        weekday: 'long',
        day: 'numeric',
        month: 'long'
    }).format(date);
}

function formatMoney(value) {
    return Number(value || 0).toLocaleString('en-US') + ' ريال';
}

function getCatalogForSession(session) {
    return CATALOG[session.carCategory];
}

function getSelectedTotal(session) {
    return (session.selectedServices || []).reduce(
        (sum, item) => sum + Number(item.price || 0),
        0
    );
}

function getDeposit(session) {
    return Math.ceil(getSelectedTotal(session) * 0.5);
}

function getRemaining(session) {
    return getSelectedTotal(session) - getDeposit(session);
}

function selectedServiceText(session) {
    return (session.selectedServices || [])
        .map(item => `${item.serviceName} — ${item.variantName}`)
        .join('\n');
}

/*
|--------------------------------------------------------------------------
| إرسال قوائم واتساب
|--------------------------------------------------------------------------
*/

async function sendCustomerRatingRequest(to, workOrderNo) {
    const buttons = [
        {
            type: 'reply',
            reply: {
                id: `rating_5_${workOrderNo}`,
                title: '⭐⭐⭐⭐⭐ ممتاز'
            }
        },
        {
            type: 'reply',
            reply: {
                id: `rating_4_${workOrderNo}`,
                title: '⭐⭐⭐⭐ جيد جدًا'
            }
        },
        {
            type: 'reply',
            reply: {
                id: `rating_3_${workOrderNo}`,
                title: '⭐⭐⭐ جيد'
            }
        },
        {
            type: 'reply',
            reply: {
                id: `rating_2_${workOrderNo}`,
                title: '⭐⭐ يحتاج تحسين'
            }
        },
        {
            type: 'reply',
            reply: {
                id: `rating_1_${workOrderNo}`,
                title: '⭐ غير راضٍ'
            }
        }
    ];

    return axios.post(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'list',
                body: {
                    text:
                        `🎉 *شكرًا لاختياركم ملوك التنجيد*\n\n` +
                        `🧾 أمر التشغيل: *${workOrderNo}*\n\n` +
                        `سعدنا بخدمتكم، ونود معرفة رأيكم في تجربتكم معنا.\n\n` +
                        `⭐ *كيف تقيّم تجربتك؟*`
                },
                footer: {
                    text: 'ملوك التنجيد 👑'
                },
                action: {
                    button: '⭐ اختر تقييمك',
                    sections: [
                        {
                            title: 'التقييم',
                            rows: buttons.map(button => ({
                                id: button.reply.id,
                                title: button.reply.title
                            }))
                        }
                    ]
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );
}



async function sendPaymentProofReviewButtons(to, booking) {
    const response = await axios.post(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text:
                        `💳 *مراجعة العربون* 👑\n\n` +
                        `🔢 *رقم الحجز:* ${booking.booking_no}\n` +
                        `👤 *العميل:* ${booking.whatsapp_from}\n\n` +
                        'هل تريد اعتماد إشعار التحويل؟'
                },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: `payment_proof_confirm_${booking.id}`,
                                title: '✅ اعتماد العربون'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: `payment_proof_reject_${booking.id}`,
                                title: '❌ رفض الإيصال'
                            }
                        }
                    ]
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );

    await saveOutgoingWhatsAppMessage({
        to,
        messageId: response.data?.messages?.[0]?.id,
        messageType: 'interactive_button',
        messageText: `مراجعة العربون — ${booking.booking_no}`,
        payload: response.data
    });

    return response.data;
}

async function sendBookingRequestConfirmation(to, booking) {
    console.log('BOOKING CENTRAL SEND:', JSON.stringify({
        to,
        booking_id: booking.id,
        booking_no: booking.booking_no
    }, null, 2));

    const buttons = [
        {
            type: 'reply',
            reply: {
                id: `booking_request_confirm_${booking.id}`,
                title: '✅ تأكيد الطلب'
            }
        },
        {
            type: 'reply',
            reply: {
                id: `booking_request_cancel_${booking.id}`,
                title: '❌ رفض الطلب'
            }
        }
    ];

    try {
        const response = await axios.post(
            `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text:
                        `🔔 *طلب حجز جديد من واتساب* 👑\n\n` +
                        `🔢 *رقم الطلب:* ${booking.booking_no}\n` +
                        `👤 *العميل:* ${booking.customer_name || ''}\n` +
                        `📱 *الهاتف:* ${booking.whatsapp_from || ''}\n` +
                        `🚗 *السيارة:* ${booking.car_type || ''}\n` +
                        `🚘 *سنة الموديل:* ${booking.model_year || ''}\n` +
                        `📍 *المحافظة:* ${booking.branch || ''}\n\n` +
                        `🧰 *الخدمات:*\n${booking.service || ''}\n\n` +
                        `💰 *الإجمالي:* ${booking.total_text || ''}\n\n` +
                        `⏳ *الحالة:* بانتظار تأكيد الطلب.\n\n` +
                        `يرجى اختيار الإجراء:`
                },
                action: {
                    buttons
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
        );

        console.log(
            'BOOKING CENTRAL SEND SUCCESS:',
            JSON.stringify(response.data, null, 2)
        );

        return response.data;

    } catch (error) {
        console.error(
            'BOOKING CENTRAL SEND ERROR:',
            JSON.stringify(
                error.response?.data || { message: error.message },
                null,
                2
            )
        );

        throw error;
    }
}

async function sendFinanceConfirmation(to, operation) {
    const amount = Number(operation.amount).toLocaleString('en-US');

    const buttons = [
        {
            type: 'reply',
            reply: {
                id: 'finance_confirm',
                title: '✅ تأكيد العملية'
            }
        },
        {
            type: 'reply',
            reply: {
                id: 'finance_cancel',
                title: '❌ إلغاء'
            }
        }
    ];

    const response = await axios.post(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text:
                        `⚠️ *تأكيد العملية المالية*\n\n` +
                        `👤 الموظف: *${operation.employeeName}*\n` +
                        `🆔 الرقم الوظيفي: *${operation.employeeNo}*\n` +
                        `💰 العملية: *${operation.action}*\n` +
                        `💵 المبلغ: *${amount} ريال*\n` +
                        `📝 البيان: ${operation.description || 'بدون بيان'}\n\n` +
                        `هل تريد تسجيل هذه العملية؟`
                },
                footer: {
                    text: 'ملوك التنجيد 👑'
                },
                action: {
                    buttons
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );

    await saveOutgoingWhatsAppMessage({
        to,
        messageId: response.data?.messages?.[0]?.id,
        messageType: 'interactive_button',
        messageText: `تأكيد العملية المالية - ${operation.employeeNo}`,
        payload: response.data
    });
}

async function sendListMessage(to, header, body, button, sectionTitle, rows) {
    const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !token) {
        throw new Error('إعدادات WhatsApp غير مكتملة');
    }

    const response = await axios.post(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'list',
                header: {
                    type: 'text',
                    text: header
                },
                body: {
                    text: body
                },
                footer: {
                    text: 'ملوك التنجيد 👑'
                },
                action: {
                    button,
                    sections: [
                        {
                            title: sectionTitle,
                            rows
                        }
                    ]
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );

    await saveOutgoingWhatsAppMessage({
        to,
        messageId: response.data?.messages?.[0]?.id,
        messageType: 'interactive_list',
        messageText: body,
        payload: response.data
    });
}

/*
|--------------------------------------------------------------------------
| كتالوج الأسعار
|--------------------------------------------------------------------------
*/

async function sendCatalog(to, category) {
    const catalog = CATALOG[category];

    if (!catalog) return;

    let text =
        '👑 *أسعار ومواصفات ملوك التنجيد*\n\n' +
        `🚗 *الفئة:* ${catalog.name}\n\n`;

    for (const serviceId of SERVICE_ORDER) {
        const service = catalog.services[serviceId];

        text += `*${service.name}*\n`;

        for (const variant of service.variants) {
            text +=
                `• ${variant.name}: *${formatMoney(variant.price)}*\n` +
                `  ${variant.specs}`;

            if (variant.warranty) {
                text += `\n  🛡️ الضمان: ${variant.warranty}`;
            }

            text += '\n';
        }

        text += '\n';
    }

    text +=
        '💡 *الأسعار المذكورة للخدمة كما هي موضحة أعلاه.*\n\n' +
        '📌 يمكنك اختيار الخدمات التي تحتاجها، وسيحسب النظام الإجمالي والعربون تلقائيًا.\n\n' +
        '💵 *العربون المطلوب لتأكيد الحجز: 50% من إجمالي قيمة العمل.*';

    await sendTextMessage(to, text);

    await sendListMessage(
        to,
        '📋 متابعة الحجز',
        'إذا كنت جاهزًا، اختر ما تريد فعله.',
        'متابعة',
        'الخيارات',
        [
            {
                id: 'start_real_booking',
                title: '📅 بدء الحجز',
                description: 'اختيار الموديل والخدمات'
            },
            {
                id: 'show_catalog_again',
                title: '💰 عرض الأسعار',
                description: 'عرض الأسعار والمواصفات مرة أخرى'
            }
        ]
    );
}

/*
|--------------------------------------------------------------------------
| اختيار فئة السيارة
|--------------------------------------------------------------------------
*/

async function sendCarCategoryMenu(to) {
    await sendListMessage(
        to,
        '🚗 فئة السيارة',
        'قبل الحجز، اختر فئة سيارتك لمعرفة الأسعار والمواصفات المناسبة لها.',
        'اختيار الفئة',
        'فئات السيارات',
        [
            {
                id: 'category_sedan',
                title: '🚘 سيدان — مرحلتان',
                description: 'صف أمام + صف وسط'
            },
            {
                id: 'category_suv',
                title: '🚙 دفع رباعي — 3 مراحل',
                description: 'ثلاثة صفوف'
            }
        ]
    );
}

/*
|--------------------------------------------------------------------------
| اختيار الخدمات
|--------------------------------------------------------------------------
*/

async function sendOfferBookingFlow(to) {
    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
        throw new Error('إعدادات WhatsApp غير مكتملة');
    }

    const flowToken = `muluk_offer_${to}_${Date.now()}`;

    const response = await axios.post(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'flow',
                header: {
                    type: 'text',
                    text: '👑 عرض ملوك التنجيد'
                },
                body: {
                    text:
                        '🎉 *العرض الخاص*\n\n' +
                        '🪑 تنجيد المقاعد: *~60,000 ريال~ 40,000 ريال*\n' +
                        '🌸 فرشة الأرضية رقم واحد: *~25,000 ريال~ 18,999 ريال*\n' +
                        '👑 فرشة الطبلون الملكي: *~6,000 ريال~ 3,999 ريال*\n' +
                        '📋 فرشة الديكور العادي: *~4,000 ريال~ 2,999 ريال*\n\n' +
                        'اختر سيارتك والخدمات المطلوبة، ثم أرسل الطلب.'
                },
                footer: {
                    text: 'ملوك التنجيد 👑'
                },
                action: {
                    name: 'flow',
                    parameters: {
                        flow_message_version: '3',
                        flow_token: flowToken,
                        flow_id: WHATSAPP_FLOW_ID,
                        flow_cta: 'احجز الآن',
                        mode: 'published'
                    }
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );

    await saveOutgoingWhatsAppMessage({
        to,
        messageId: response.data?.messages?.[0]?.id,
        messageType: 'interactive_flow',
        messageText: '👑 عرض ملوك التنجيد',
        payload: response.data
    });
}

async function sendServiceMenu(to, session) {
    const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !token) {
        throw new Error('إعدادات WhatsApp غير مكتملة');
    }

    const flowToken = `muluk_${to}_${Date.now()}`;

    const response = await axios.post(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'flow',
                header: {
                    type: 'text',
                    text: '🧰 اختيار الخدمات'
                },
                body: {
                    text:
                        'اختر جميع الخدمات التي تحتاجها دفعة واحدة.\n\n' +
                        'بعد الإرسال سيطلب منك النظام نوعية كل خدمة وسعرها.'
                },
                footer: {
                    text: 'ملوك التنجيد 👑'
                },
                action: {
                    name: 'flow',
                    parameters: {
                        flow_message_version: '3',
                        flow_token: flowToken,
                        flow_id: WHATSAPP_FLOW_ID,
                        flow_cta: 'اختيار الخدمات',
                        mode: 'published'
                    }
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );

    await saveOutgoingWhatsAppMessage({
        to,
        messageId: response.data?.messages?.[0]?.id,
        messageType: 'interactive_flow',
        messageText: '🧰 اختيار الخدمات',
        payload: response.data
    });
}

/*
|--------------------------------------------------------------------------
| اختيار نوع الخدمة
|--------------------------------------------------------------------------
*/

async function sendVariantMenu(to, session, serviceId) {
    const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !token) {
        throw new Error('إعدادات WhatsApp غير مكتملة');
    }

    // الفئة الصحيحة محفوظة في carCategory
    const carKey =
        session.carCategory === 'sedan' ? 'sedan' :
        session.carCategory === 'suv' ? 'suv' :
        null;

    if (!carKey) {
        throw new Error(`فئة السيارة غير صحيحة: ${session.carCategory}`);
    }

    const service = CATALOG[carKey]?.services?.[serviceId];

    if (!service) {
        throw new Error(`الخدمة غير موجودة: ${serviceId}`);
    }

    const variants = service.variants || [];

    const lines = [
        `🧰 ${service.name}`,
        '',
        'اختر النوع المناسب:',
        ''
    ];

    variants.forEach((v, i) => {
        lines.push(
            `${i + 1}. ${v.name} — ${Number(v.price).toLocaleString('en-US')} ريال`
        );

        if (v.specs) {
            lines.push(`   ${v.specs}`);
        }

        if (v.warranty) {
            lines.push(`   🛡️ الضمان: ${v.warranty}`);
        }

        lines.push('');
    });

    const buttons = variants.slice(0, 3).map(v => ({
        type: 'reply',
        reply: {
            id: `variant_${serviceId}_${v.id}`,
            title: `${v.name} ${Number(v.price).toLocaleString('en-US')}`
                .trim()
                .slice(0, 20)
        }
    }));

    const response = await axios.post(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text: lines.join('\n')
                },
                footer: {
                    text: 'ملوك التنجيد 👑'
                },
                action: {
                    buttons
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );

    await saveOutgoingWhatsAppMessage({
        to,
        messageId: response.data?.messages?.[0]?.id,
        messageType: 'interactive_button',
        messageText: lines.join('\\n'),
        payload: response.data
    });
}


/*
|--------------------------------------------------------------------------
| بعد اختيار الخدمة
|--------------------------------------------------------------------------
*/

async function sendContinueServicesMenu(to, session) {
    const total = getSelectedTotal(session);

    const rows = [
        {
            id: 'add_more_service',
            title: '➕ إضافة خدمة أخرى',
            description: 'اختيار خدمة إضافية'
        },
        {
            id: 'remove_service',
            title: '🗑️ إلغاء خدمة',
            description: 'حذف خدمة من اختياراتك'
        },
        {
            id: 'finish_services',
            title: '✅ إنهاء الخدمات',
            description: 'الانتقال إلى الموعد'
        }
    ];

    await sendListMessage(
        to,
        '✅ الخدمات المختارة',
        `تم تحديث اختياراتك.\n\n💰 الإجمالي الحالي: *${formatMoney(total)}*`,
        'متابعة',
        'الخيارات',
        rows
    );
}

async function sendRemoveServiceMenu(to, session) {
    const services = session.selectedServices || [];

    if (!services.length) {
        session.step = 'SERVICES';
        bookingSessions.set(to, session);
        await sendServiceMenu(to, session);
        return;
    }

    const rows = services.map((item, index) => ({
        id: `remove_selected_${index}`,
        title: `🗑️ ${item.serviceName}`.slice(0, 24),
        description: `${item.variantName} — ${formatMoney(item.price)}`
    }));

    await sendListMessage(
        to,
        '🗑️ إلغاء خدمة',
        'اختر الخدمة التي تريد إلغاءها فقط:',
        'اختيار الخدمة',
        'الخدمات الحالية',
        rows
    );
}

/*
|--------------------------------------------------------------------------
| الأيام المتاحة
|--------------------------------------------------------------------------
*/

async function getAvailableDays() {
    const today = getTodayInYemen();
    const totalCapacity =
        BRANCHES.length * DAILY_CAPACITY;

    const result = await pool.query(
        `
        SELECT booking_date, COUNT(*)::int AS booked
        FROM whatsapp_bookings
        WHERE booking_date IS NOT NULL
          AND status NOT IN ('CANCELLED')
          AND booking_date >= $1::date
        GROUP BY booking_date
        ORDER BY booking_date
        `,
        [dateKey(today)]
    );

    const bookedMap = new Map();

    for (const row of result.rows) {
        bookedMap.set(
            String(row.booking_date),
            Number(row.booked)
        );
    }

    const days = [];

    for (let i = 1; i <= 10; i++) {
        const date = addDays(today, i);
        const key = dateKey(date);
        const booked = bookedMap.get(key) || 0;
        const available = booked < totalCapacity;

        days.push({
            key,
            label: formatArabicDate(date),
            available,
            booked
        });
    }

    return days;
}
async function sendAvailableDaysMenu(to) {
    const days = await getAvailableDays();

    if (!days.length) {
        await sendTextMessage(
            to,
            '📅 نعتذر، لا توجد مواعيد متاحة حاليًا.\n\n' +
            'يرجى التواصل مع موظف ملوك التنجيد لتنسيق موعد مناسب.'
        );
        return false;
    }

    await sendListMessage(
        to,
        '📅 مواعيد الحجز',
        'اختر اليوم المناسب لك. الأيام الممتلئة تظهر كغير متاحة.',
        'اختيار اليوم',
        'الأيام',
        days.map(day => ({
            id: `booking_day_${day.key.replace(/-/g, '_')}`,
            title: `${day.available ? '🟢' : '🔴'} ${day.label}`,
            description: day.available ? 'موعد متاح' : 'غير متاح'
        }))
    );

    return true;
}

/*
|--------------------------------------------------------------------------
| اختيار الفرع داخليًا
|--------------------------------------------------------------------------
*/

async function assignBranch(bookingDate) {
    const result = await pool.query(
        `
        SELECT branch, COUNT(*)::int AS booked
        FROM whatsapp_bookings
        WHERE booking_date = $1
          AND status NOT IN ('CANCELLED')
        GROUP BY branch
        `,
        [bookingDate]
    );

    const counts = {};

    for (const branch of BRANCHES) {
        counts[branch] = 0;
    }

    for (const row of result.rows) {
        if (counts[row.branch] !== undefined) {
            counts[row.branch] = Number(row.booked);
        }
    }

    const availableBranches = BRANCHES
        .filter(branch => counts[branch] < DAILY_CAPACITY)
        .sort((a, b) => counts[a] - counts[b]);

    return availableBranches[0] || null;
}

/*
|--------------------------------------------------------------------------
| مراجعة الحجز + العربون
|--------------------------------------------------------------------------
*/

async function sendConfirmationMenu(to, session) {
    const total = getSelectedTotal(session);
    const deposit = getDeposit(session);
    const remaining = getRemaining(session);

    const body =
        '📋 *مراجعة الحجز* 👑\n\n' +
        `🚗 *فئة السيارة:* ${session.carCategoryName}\n` +
        `🚘 *الموديل:* ${session.model}\n\n` +
        `🧰 *الخدمات المختارة:*\n${selectedServiceText(session)}\n\n` +
        `📅 *الموعد:* ${session.dayLabel}\n\n` +
        `💰 *إجمالي العمل:* ${formatMoney(total)}\n` +
        `💵 *العربون 50%:* ${formatMoney(deposit)}\n` +
        `💳 *المتبقي:* ${formatMoney(remaining)}\n\n` +
        '⚠️ *تنبيه مهم:*\n' +
        'لا يعتبر الحجز مؤكدًا إلا بعد دفع عربون بنسبة *50%* من إجمالي قيمة العمل.\n\n' +
        'عند التأكيد سيتم تسجيل الطلب بحالة *بانتظار دفع العربون*.';

    const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    const response = await axios.post(
        `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text: body
                },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: 'confirm_booking',
                                title: '✅ متابعة للعربون'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'cancel_booking',
                                title: '❌ إلغاء'
                            }
                        }
                    ]
                }
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );

    await saveOutgoingWhatsAppMessage({
        to,
        messageId: response.data?.messages?.[0]?.id,
        messageType: 'interactive_button',
        messageText: body,
        payload: response.data
    });
}

/*
|--------------------------------------------------------------------------
| القائمة العامة
|--------------------------------------------------------------------------
*/

async function sendStaffMenu(to) {
    await sendListMessage(
        to,
        '👨‍💼 التحدث مع موظف',
        'اختر طريقة التواصل التي تناسبك 👇',
        'التواصل',
        'اختر',
        [
            {
                id: 'staff_call',
                title: '📞 اتصال',
                description: 'الاتصال مباشرة بالموظف'
            },
            {
                id: 'staff_whatsapp',
                title: '💬 واتساب',
                description: 'فتح محادثة واتساب'
            }
        ]
    );
}

async function sendAddressMenu(to) {
    await sendListMessage(
        to,
        '📍 العنوان',
        'اختر الفرع الذي تريد معرفة موقعه على الخريطة 👇',
        'الفروع',
        'المواقع',
        [
            {
                id: 'location_main',
                title: '🗺️ الفرع الرئيسي',
                description: 'شارع الستين - جوار جسر مذبح'
            },
            {
                id: 'location_tunis',
                title: '🗺️ فرع شارع تونس',
                description: 'مقابل مخابز تونس الآلية'
            }
        ]
    );
}

async function sendInteractiveMenu(to, customerName = 'عميلنا') {
    await sendListMessage(
        to,
        '' ,
        `👋 أهلًا بك عميلنا في ملوك التنجيد\n\nأنا *راشــــد* 🤵‍♂️\nمساعدك الرقمي في ملوك التنجيد.\nأساعدك في معرفة الخدمات والأسعار والمواصفات، واختيار ما يناسب سيارتك وحجز موعدك بكل سهولة.\n\n*الرجاء الاختيار من القائمة 👇*`,
        'القائمة',
        'الخدمات',
        [
            {
                id: 'book',
                title: '🚗 حجز موعد',
                description: 'ابدأ حجز موعد جديد'
            },
            {
                id: 'services',
                title: '🧰 الخدمات والأسعار',
                description: 'تعرف على الخدمات المتاحة'
            },
            {
                id: 'address',
                title: '📍 العنوان',
                description: 'مواقع فروع ملوك التنجيد'
            },
            {
                id: 'staff',
                title: '👨‍💼 التحدث مع موظف',
                description: 'التواصل مباشرة مع موظف'
            }
        ]
    );
}

/*
|--------------------------------------------------------------------------
| Webhook GET
|--------------------------------------------------------------------------
*/

router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WhatsApp Webhook verified successfully');
        return res.status(200).send(challenge);
    }

    console.warn('WhatsApp Webhook verification failed');
    return res.sendStatus(403);
});

/*
|--------------------------------------------------------------------------
| Webhook POST
|--------------------------------------------------------------------------
*/

router.post('/webhook', (req, res) => {
    try {
        const body = req.body;

        console.log(
            'WhatsApp Webhook received:',
            JSON.stringify(body, null, 2)
        );

        res.sendStatus(200);

        processWhatsAppEvent(body).catch(error => {
            console.error(
                'WhatsApp Event Processing Error:',
                JSON.stringify(
                    error.response?.data || error.message,
                    null,
                    2
                )
            );
        });
    } catch (error) {
        console.error(
            'WhatsApp Webhook Error:',
            error.message
        );

        if (!res.headersSent) {
            res.sendStatus(500);
        }
    }
});

/*
|--------------------------------------------------------------------------
| معالجة رسائل واتساب
|--------------------------------------------------------------------------
*/


async function saveIncomingWhatsAppMessage({
    from,
    customerName,
    message,
    displayText
}) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const conversationResult = await client.query(
            `
            INSERT INTO whatsapp_conversations
                (wa_id, customer_name, last_message_text, last_message_at, unread_count, updated_at)
            VALUES
                ($1, $2, $3, NOW(), 1, NOW())
            ON CONFLICT (wa_id)
            DO UPDATE SET
                customer_name = COALESCE(EXCLUDED.customer_name, whatsapp_conversations.customer_name),
                last_message_text = EXCLUDED.last_message_text,
                last_message_at = NOW(),
                unread_count = whatsapp_conversations.unread_count + 1,
                updated_at = NOW()
            RETURNING id
            `,
            [
                from,
                customerName || null,
                displayText || null
            ]
        );

        const conversationId = conversationResult.rows[0].id;

        await client.query(
            `
            INSERT INTO whatsapp_messages
                (
                    conversation_id,
                    whatsapp_message_id,
                    direction,
                    message_type,
                    message_text,
                    payload,
                    status
                )
            VALUES
                ($1, $2, 'INBOUND', $3, $4, $5::jsonb, 'RECEIVED')
            ON CONFLICT (whatsapp_message_id)
            DO NOTHING
            `,
            [
                conversationId,
                message.id,
                message.type || 'unknown',
                displayText || null,
                JSON.stringify(message)
            ]
        );

        await client.query('COMMIT');

        return conversationId;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(
            'WhatsApp message save error:',
            error.message
        );
        throw error;
    } finally {
        client.release();
    }
}

async function processWhatsAppEvent(body) {
    if (!body || body.object !== 'whatsapp_business_account') {
        return;
    }

    const entries = body.entry || [];

    for (const entry of entries) {
        const changes = entry.changes || [];

        for (const change of changes) {
            const value = change.value;

            if (!value) continue;

            const messages = value.messages || [];

            for (const message of messages) {
                const from = message.from;
                const CENTRAL_FINANCE_PHONE = '967733380757';


                // اسم العميل المسجل في واتساب
                const customerName =
                    value.contacts?.[0]?.profile?.name?.trim() ||
                    'عميلنا العزيز';

console.log('New WhatsApp message:', {
                    from,
                    messageId: message.id,
                    type: message.type
                });

                const depositLock = await pool.query(
                    `
                    SELECT id
                    FROM whatsapp_bookings
                    WHERE whatsapp_from = $1
                      AND status = 'PENDING_DEPOSIT'
                      AND payment_proof_status = 'NOT_RECEIVED'
                    ORDER BY created_at DESC, id DESC
                    LIMIT 1
                    `,
                    [from]
                );

                if (
                    from !== CENTRAL_FINANCE_PHONE &&
                    depositLock.rows.length &&
                    message.type !== 'image'
                ) {
                    console.log(
                        'WhatsApp waiting for payment proof - ignoring message:',
                        from,
                        message.type
                    );
                    continue;
                }

                let text = '';
                if (message.type === 'text') {
                    text = message.text?.body?.trim() || '';

                    // طلب الموافقة على الرسائل التسويقية
                    if (
                        from !== CENTRAL_FINANCE_PHONE &&
                        from !== 'INTERNAL-EMPLOYEE' &&
                        text === 'موافقة'
                    ) {
                        await sendTextMessage(
                            from,
                            '📢 *موافقة الرسائل التسويقية*\n\n' +
                            'هل ترغب في استقبال عروض وأسعار ملوك التنجيد عبر واتساب؟'
                        );

                        await axios.post(
                            `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
                            {
                                messaging_product: 'whatsapp',
                                to: from,
                                type: 'interactive',
                                interactive: {
                                    type: 'button',
                                    body: {
                                        text: 'اختر أحد الخيارات:'
                                    },
                                    action: {
                                        buttons: [
                                            {
                                                type: 'reply',
                                                reply: {
                                                    id: 'marketing_opt_in_yes',
                                                    title: '✅ أوافق'
                                                }
                                            },
                                            {
                                                type: 'reply',
                                                reply: {
                                                    id: 'marketing_opt_in_no',
                                                    title: '❌ لا أرغب'
                                                }
                                            }
                                        ]
                                    }
                                }
                            },
                            {
                                headers: {
                                    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                    'Content-Type': 'application/json'
                                },
                                timeout: 30000
                            }
                        );

                        continue;
                    }

                    const statementMatch =
                        from === CENTRAL_FINANCE_PHONE
                            ? text.match(/^(?:EMP-[0-9]+\s+كشف|كشف\s+EMP-[0-9]+)$/i)
                            : null;

                    if (statementMatch) {
                        const employeeNo =
                        (text.match(/EMP-[0-9]+/i)?.[0] || '').toUpperCase();

                        const employeeResult = await pool.query(
                            `
                            SELECT employee_id, employee_no, full_name, phone
                            FROM employees
                            WHERE UPPER(employee_no) = $1
                              AND is_active = TRUE
                            LIMIT 1
                            `,
                            [employeeNo]
                        );

                        const employee = employeeResult.rows[0];

                        if (!employee) {
                            await sendTextMessage(
                                from,
                                `⚠️ الرقم الوظيفي *${employeeNo}* غير موجود أو غير نشط.`
                            );
                            continue;
                        }

                        const balanceResult = await pool.query(
                            `
                            SELECT
                                COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS total_credit,
                                COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS total_debit
                            FROM employee_financial_transactions
                            WHERE employee_id = $1
                            `,
                            [employee.employee_id]
                        );

                        const totalCredit =
                            Number(balanceResult.rows[0].total_credit);

                        const totalDebit =
                            Number(balanceResult.rows[0].total_debit);

                        const netBalance = totalCredit - totalDebit;

                        const recentResult = await pool.query(
                            `
                            SELECT transaction_no, direction, amount, description, transaction_date
                            FROM employee_financial_transactions
                            WHERE employee_id = $1
                            ORDER BY transaction_date DESC, transaction_id DESC
                            LIMIT 10
                            `,
                            [employee.employee_id]
                        );

                        const formatAmount = (value) =>
                            Number(value).toLocaleString('en-US');

                        let statement =
                            `📋 *كشف حساب الموظف*\n\n` +
                            `👤 الموظف: *${employee.full_name}*\n` +
                            `🆔 الرقم الوظيفي: *${employee.employee_no}*\n\n` +
                            `💚 *له: ${formatAmount(totalCredit)} ريال*\n` +
                            `🔴 *عليه: ${formatAmount(totalDebit)} ريال*\n` +
                            `⚖️ *الصافي: ${netBalance >= 0 ? 'له' : 'عليه'} ${formatAmount(Math.abs(netBalance))} ريال*\n\n` +
                            `🧾 *آخر العمليات:*\n`;

                        if (!recentResult.rows.length) {
                            statement += `لا توجد عمليات مسجلة.`;
                        } else {
                            for (const row of recentResult.rows) {
                                const type =
                                    row.direction === 'CREDIT'
                                        ? '💚 قبض'
                                        : '🔴 صرف';

                                statement +=
                                    `\n${type} — ${formatAmount(row.amount)} ريال` +
                                    `\n📝 ${row.description || 'بدون بيان'}` +
                                    `\n🧾 ${row.transaction_no}\n`;
                            }
                        }

                        await sendTextMessage(from, statement);
                        continue;
                    }

                    const financeMatch =
                        from === CENTRAL_FINANCE_PHONE
                            ? text.match(
                                /^(قبض|صرف|خصم)\s+([0-9]+(?:[.,][0-9]+)?)\s*ريال?\s*(.*?)\s+(EMP-[0-9]+)$/i
                            )
                            : null;

                    console.log('FINANCE DEBUG:', {
                        from,
                        central: CENTRAL_FINANCE_PHONE,
                        text,
                        isCentral: from === CENTRAL_FINANCE_PHONE,
                        matched: !!financeMatch
                    });

                    if (financeMatch) {
                        const action = financeMatch[1];
                        const amount = Number(
                            financeMatch[2].replace(/,/g, '')
                        );
                        const description = financeMatch[3]?.trim() || null;
                        const employeeNo = financeMatch[4].toUpperCase();

                        const employeeResult = await pool.query(
                            `
                            SELECT employee_id, employee_no, full_name, phone
                            FROM employees
                            WHERE UPPER(employee_no) = $1
                              AND is_active = TRUE
                            LIMIT 1
                            `,
                            [employeeNo]
                        );

                        const employee = employeeResult.rows[0];

                        if (!employee) {
                            await sendTextMessage(
                                from,
                                `⚠️ الرقم الوظيفي *${employeeNo}* غير موجود أو غير نشط.`
                            );
                            continue;
                        }

                        if (!Number.isFinite(amount) || amount <= 0) {
                            await sendTextMessage(
                                from,
                                '⚠️ المبلغ غير صحيح.'
                            );
                            continue;
                        }

                        bookingSessions.set(from, {
                            step: 'FINANCE_CONFIRM',
                            employeeId: employee.employee_id,
                            employeeNo: employee.employee_no,
                            employeeName: employee.full_name,
                            employeePhone: employee.phone,
                            action,
                            amount,
                              transactionType: action === "خصم" ? "DEDUCTION" : "ADJUSTMENT",
                            description
                        });

                        await sendFinanceConfirmation(from, {
                            employeeNo: employee.employee_no,
                            employeeName: employee.full_name,
                            action,
                            amount,
                            description
                        });

                        continue;

                        try {
                            const transaction =
                                await createEmployeeFinancialTransaction({
                                    employeeId: employee.employee_id,
                                    amount,
                                    direction:
                                        action === 'قبض'
                                            ? 'CREDIT'
                                            : 'DEBIT',
                                    description,
                                    from
                                });

                            const formattedAmount =
                                Number(transaction.amount)
                                    .toLocaleString('en-US');

                            await sendTextMessage(
                                from,
                                `✅ *تم تسجيل العملية*\n\n` +
                                `👤 الموظف: *${employee.full_name}*\n` +
                                `🆔 الرقم الوظيفي: *${employee.employee_no}*\n` +
                                `💰 النوع: *${action}*\n` +
                                `💵 المبلغ: *${formattedAmount} ريال*\n` +
                                (description
                                    ? `📝 البيان: ${description}\n`
                                    : '') +
                                `🧾 رقم العملية: *${transaction.transaction_no}*\n\n` +
                                `📲 تم إرسال إشعار العملية إلى جوال الموظف.`
                            );

                            const balanceResult = await pool.query(
                                `
                                SELECT
                                    COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS total_credit,
                                    COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS total_debit
                                FROM employee_financial_transactions
                                WHERE employee_id = $1
                                `,
                                [employee.employee_id]
                            );

                            const totalCredit =
                                Number(balanceResult.rows[0].total_credit);

                            const totalDebit =
                                Number(balanceResult.rows[0].total_debit);

                            const netBalance = totalCredit - totalDebit;

                            const formattedCredit =
                                totalCredit.toLocaleString('en-US');

                            const formattedDebit =
                                totalDebit.toLocaleString('en-US');

                            const formattedNet =
                                Math.abs(netBalance).toLocaleString('en-US');

                            const balanceLine =
                                netBalance >= 0
                                    ? `⚖️ *الصافي لك: ${formattedNet} ريال*`
                                    : `⚖️ *الصافي عليك: ${formattedNet} ريال*`;

                            const employeePhone =
                                String(employee.phone || '')
                                    .replace(/\D/g, '');

                            if (employeePhone.length >= 9) {
                                const notificationText =
                                    `🔔 *إشعار مالي من ملوك التنجيد*\n\n` +
                                    `تم تسجيل عملية *${action}* للموظف *${employee.full_name}* بمبلغ *${formattedAmount} ريال*.\n\n` +
                                    `شكرًا لك، ملوك التنجيد 👑`;
                            await sendTemplateMessage(
                                employeePhone,
                                'employee_finance_notification',
                                'ar',
                                [
                                    action,
                                    employee.full_name,
                                    formattedAmount
                                ]
                            );
                            }

                            console.log(
                                'Central employee financial transaction created:',
                                transaction
                            );

                            continue;
                        } catch (error) {
                            console.error(
                                'Central employee finance error:',
                                error.message
                            );

                            await sendTextMessage(
                                from,
                                '❌ حدث خطأ أثناء تسجيل العملية.\\n\\nيرجى المحاولة مرة أخرى.'
                            );

                            continue;
                        }
                    }
                }

                else if (message.type === 'image') {
                    const mediaId =
                        message.image?.id || '';

                    if (!mediaId) {
                        console.error(
                            'WhatsApp image received without media id:',
                            message.id
                        );
                        continue;
                    }

                    try {
                        const bookingResult = await pool.query(
                            `
                            SELECT
                                id,
                                booking_no
                            FROM whatsapp_bookings
                            WHERE whatsapp_from = $1
                              AND status = 'PENDING_DEPOSIT'
                              AND payment_proof_status = 'NOT_RECEIVED'
                            ORDER BY created_at DESC, id DESC
                            LIMIT 1
                            `,
                            [from]
                        );

                        if (!bookingResult.rows.length) {
                            console.log(
                                'WhatsApp payment image received but no pending booking:',
                                from
                            );
                            continue;
                        }

                        const booking =
                            bookingResult.rows[0];

                        const path =
                            require('path');

                        const filePath =
                            path.join(
                                process.cwd(),
                                'storage',
                                'whatsapp-payment-proofs',
                                `${booking.booking_no}-${mediaId}.jpg`
                            );

                        const media =
                            await downloadWhatsAppMedia(
                                mediaId,
                                filePath
                            );

                        await pool.query(
                            `
                            UPDATE whatsapp_bookings
                            SET
                                payment_proof_media_id = $1,
                                payment_proof_received_at = NOW(),
                                payment_proof_status = 'PENDING_REVIEW'
                            WHERE id = $2
                            `,
                            [
                                media.mediaId,
                                booking.id
                            ]
                        );


                        try {
                            await sendTextMessage(
                                CENTRAL_FINANCE_PHONE,
                                `💳 *إشعار تحويل جديد* 👑

` +
                                `🔢 *رقم الحجز:* ${booking.booking_no}

` +
                                `👤 *العميل:* ${from}

` +
                                `⏳ *الحالة:* بانتظار مراجعة واعتماد العربون.

` +
                                `🖼️ سيتم إرفاق صورة إشعار التحويل الآن.`
                            );

                            await sendImageMessage(
                                CENTRAL_FINANCE_PHONE,
                                media.mediaId,
                                `💳 إشعار تحويل — الحجز ${booking.booking_no}`
                            );

                            await sendPaymentProofReviewButtons(
                                CENTRAL_FINANCE_PHONE,
                                booking
                            );

                            console.log(
                                'Payment proof forwarded to central:',
                                {
                                    bookingId: booking.id,
                                    bookingNo: booking.booking_no,
                                    central: CENTRAL_FINANCE_PHONE
                                }
                            );
                        } catch (forwardError) {
                            console.error(
                                'Payment proof central notification error:',
                                forwardError.response?.data || forwardError.message
                            );
                        }

                        console.log(
                            'Payment proof received:',
                            {
                                bookingId: booking.id,
                                bookingNo: booking.booking_no,
                                mediaId: media.mediaId,
                                filePath: media.filePath
                            }
                        );

                    } catch (error) {
                        console.error(
                            'WhatsApp payment proof error:',
                            error.message
                        );
                    }

                    continue;
                }

                else if (message.type === 'interactive') {
                    const selectedId =
                        message.interactive?.list_reply?.id ||
                        message.interactive?.button_reply?.id ||
                        '';

                    // معالجة الموافقة التسويقية
                    if (
                        selectedId === 'marketing_opt_in_yes' ||
                        selectedId === 'marketing_opt_in_no'
                    ) {
                        const marketingOptIn =
                            selectedId === 'marketing_opt_in_yes';

                        const consentResult = await pool.query(
                            `
                            UPDATE customers
                            SET
                                marketing_opt_in = $1,
                                marketing_opt_in_at = NOW(),
                                marketing_opt_in_source = 'whatsapp'
                            WHERE phone IS NOT NULL
                              AND phone <> 'INTERNAL-EMPLOYEE'
                              AND RIGHT(
                                  regexp_replace(phone, '[^0-9]', '', 'g'),
                                  9
                              ) = RIGHT(
                                  regexp_replace($2, '[^0-9]', '', 'g'),
                                  9
                              )
                            RETURNING
                                customer_id,
                                full_name,
                                phone,
                                marketing_opt_in,
                                marketing_opt_in_at,
                                marketing_opt_in_source
                            `,
                            [marketingOptIn, from]
                        );

                        if (!consentResult.rows.length) {
                            await sendTextMessage(
                                from,
                                '⚠️ لم نجد رقمك في سجلات العملاء.\n\n' +
                                'يرجى التواصل مع ملوك التنجيد لتسجيل بياناتك.'
                            );
                            continue;
                        }

                        if (marketingOptIn) {
                            await sendTextMessage(
                                from,
                                '✅ تم تسجيل موافقتك بنجاح.\n\n' +
                                'ستصلك عروض وأسعار ملوك التنجيد عبر واتساب. 👑'
                            );
                        } else {
                            await sendTextMessage(
                                from,
                                '✅ تم تسجيل إلغاء الموافقة.\n\n' +
                                'لن يتم إرسال الرسائل التسويقية والعروض إليك.'
                            );
                        }

                        console.log(
                            'MARKETING CONSENT:',
                            JSON.stringify({
                                phone: from,
                                marketing_opt_in: marketingOptIn,
                                updated_customers: consentResult.rows.map(
                                    row => row.customer_id
                                )
                            }, null, 2)
                        );

                        continue;
                    }

                    const bookingSession =
                        bookingSessions.get(from);

                    /*
                    |--------------------------------------------------------------------------
                    | Flow القديم: إذا وصل من جلسة سابقة، نطلب إعادة بدء الحجز
                    |--------------------------------------------------------------------------
                    */
                    if (message.interactive?.type === 'nfm_reply') {
                        let flowData = {};

                        try {
                            const raw =
                                message.interactive?.nfm_reply?.response_json ||
                                message.interactive?.nfm_reply?.data ||
                                '{}';

                            flowData =
                                typeof raw === 'string'
                                    ? JSON.parse(raw)
                                    : (raw || {});
                        } catch (flowError) {
                            console.error(
                                'WhatsApp Flow response parse error:',
                                flowError.message
                            );

                            await sendTextMessage(
                                from,
                                '⚠️ تعذر قراءة طلب الحجز، يرجى المحاولة مرة أخرى.'
                            );
                            continue;
                        }

                        let selectedServiceIds = flowData.services;

                        if (typeof selectedServiceIds === 'string') {
                            try {
                                selectedServiceIds = JSON.parse(selectedServiceIds);
                            } catch {
                                selectedServiceIds = selectedServiceIds
                                    .split(',')
                                    .map(v => v.trim())
                                    .filter(Boolean);
                            }
                        }

                        if (!Array.isArray(selectedServiceIds)) {
                            selectedServiceIds = [];
                        }

                        selectedServiceIds = selectedServiceIds
                            .map(String)
                            .map(v => v.trim())
                            .filter(v =>
                                Object.prototype.hasOwnProperty.call(
                                    OFFER_SERVICES,
                                    v
                                )
                            );

                        const carId = String(flowData.car || '').trim();
                        const modelYear = String(flowData.model_year || '').trim();
                        const customerName = String(flowData.customer_name || '').trim();
                        const governorateId = String(flowData.governorate || '').trim();

                        const carName = OFFER_CARS[carId] || carId;
                        const governorateName =
                            OFFER_GOVERNORATES[governorateId] || governorateId;

                        if (
                            !carId ||
                            !modelYear ||
                            !customerName ||
                            !governorateId
                        ) {
                            await sendTextMessage(
                                from,
                                '⚠️ بيانات الحجز غير مكتملة.\n\nيرجى إعادة فتح الحجز وإكمال جميع البيانات.'
                            );
                            continue;
                        }

                        if (!selectedServiceIds.length) {
                            await sendTextMessage(
                                from,
                                '⚠️ يجب اختيار خدمة واحدة على الأقل.'
                            );
                            continue;
                        }

                        if (carId === 'rav4' && Number(modelYear) > 2018) {
                            await sendTextMessage(
                                from,
                                '⚠️ عرض راف فور متاح لموديلات 2018 أو أقدم فقط.'
                            );
                            continue;
                        }

                        const services = selectedServiceIds.map(id => ({
                            id,
                            name: OFFER_SERVICES[id].name,
                            price: Number(OFFER_SERVICES[id].price)
                        }));

                        const total = services.reduce(
                            (sum, item) => sum + item.price,
                            0
                        );

                        const serviceText = services
                            .map(item =>
                                `${item.name} — ${formatMoney(item.price)}`
                            )
                            .join(' + ');

                        const bookingNo =
                            'WA-' +
                            new Date()
                                .toISOString()
                                .replace(/[-:TZ.]/g, '')
                                .slice(0, 14) +
                            '-' +
                            Math.floor(Math.random() * 1000);

                        const savedService =
                            `${serviceText} | الإجمالي: ${formatMoney(total)}`;

                        const bookingResult = await pool.query(
                            `
                            INSERT INTO whatsapp_bookings
                            (
                                booking_no,
                                whatsapp_from,
                                customer_name,
                                car_type,
                                model_year,
                                service,
                                branch,
                                booking_day,
                                booking_time,
                                booking_date,
                                status
                            )
                            VALUES
                            ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,'PENDING')
                            RETURNING id, booking_no
                            `,
                            [
                                bookingNo,
                                from,
                                customerName,
                                carName,
                                modelYear,
                                savedService,
                                governorateName
                            ]
                        );

                        const savedBooking = bookingResult.rows[0];

                        await sendTextMessage(
                            from,
                            '✅ *تم استلام طلب العرض بنجاح* 👑\n\n' +
                            `🔢 *رقم الطلب:* ${savedBooking.booking_no}\n` +
                            `👤 *الاسم:* ${customerName}\n` +
                            `🚗 *السيارة:* ${carName}\n` +
                            `🚘 *سنة الموديل:* ${modelYear}\n` +
                            `📍 *المحافظة:* ${governorateName}\n\n` +
                            `🧰 *الخدمات:*\n${serviceText}\n\n` +
                            `💰 *الإجمالي:* ${formatMoney(total)}\n\n` +
                            '⏳ *الحالة:* بانتظار تحديد الموعد.\n\n' +
                            '📞 سيتم التواصل معك عبر واتساب لتحديد الموعد وتأكيد الحجز.\n\n' +
                            'شكرًا لاختيارك *ملوك التنجيد* 👑🚗'
                        );

                        if (CENTRAL_FINANCE_PHONE !== from) {
                                await sendBookingRequestConfirmation(
                                    CENTRAL_FINANCE_PHONE,
                                    {
                                        id: savedBooking.id,
                                        booking_no: savedBooking.booking_no,
                                        customer_name: customerName,
                                        whatsapp_from: from,
                                        car_type: carName,
                                        model_year: modelYear,
                                        branch: governorateName,
                                        service: serviceText,
                                        total_text: formatMoney(total)
                                    }
                                );
                        }
continue;
                    }

                    if (
                        selectedId === 'finance_confirm' ||
                        selectedId === 'finance_cancel'
                    ) {
                        const pendingFinance = bookingSessions.get(from);

                        if (
                            !pendingFinance ||
                            pendingFinance.step !== 'FINANCE_CONFIRM'
                        ) {
                            await sendTextMessage(
                                from,
                                '⚠️ لا توجد عملية مالية معلقة للتأكيد.'
                            );
                            continue;
                        }

                        if (selectedId === 'finance_cancel') {
                            bookingSessions.delete(from);

                            await sendTextMessage(
                                from,
                                '❌ *تم إلغاء العملية المالية.*\n\n' +
                                'لم يتم تسجيل أي مبلغ في الحساب.'
                            );
                            continue;
                        }

                        try {
                            const transaction =
                                await createEmployeeFinancialTransaction({
                                    employeeId: pendingFinance.employeeId,
                                    amount: pendingFinance.amount,
                                    direction:
                                        pendingFinance.action === 'قبض'
                                            ? 'CREDIT'
                                            : 'DEBIT',
                                    transactionType: pendingFinance.transactionType || 'ADJUSTMENT',
                                                    description: pendingFinance.description,
                                    from
                                });

                            bookingSessions.delete(from);

                            const formattedAmount =
                                Number(transaction.amount)
                                    .toLocaleString('en-US');

                            const balanceResult = await pool.query(
                                `
                                SELECT
                                    COALESCE(
                                        SUM(
                                            CASE
                                                WHEN direction = 'CREDIT'
                                                THEN amount ELSE 0
                                            END
                                        ), 0
                                    ) AS total_credit,
                                    COALESCE(
                                        SUM(
                                            CASE
                                                WHEN direction = 'DEBIT'
                                                THEN amount ELSE 0
                                            END
                                        ), 0
                                    ) AS total_debit
                                FROM employee_financial_transactions
                                WHERE employee_id = $1
                                `,
                                [pendingFinance.employeeId]
                            );

                            const totalCredit =
                                Number(balanceResult.rows[0].total_credit);

                            const totalDebit =
                                Number(balanceResult.rows[0].total_debit);

                            const netBalance = totalCredit - totalDebit;

                            const formattedCredit =
                                totalCredit.toLocaleString('en-US');

                            const formattedDebit =
                                totalDebit.toLocaleString('en-US');

                            const formattedNet =
                                Math.abs(netBalance)
                                    .toLocaleString('en-US');

                            const balanceLine =
                                netBalance >= 0
                                    ? `⚖️ *الصافي لك: ${formattedNet} ريال*`
                                    : `⚖️ *الصافي عليك: ${formattedNet} ريال*`;

                            await sendTextMessage(
                                from,
                                `✅ *تم تسجيل العملية*\n\n` +
                                `👤 الموظف: *${pendingFinance.employeeName}*\n` +
                                `🆔 الرقم الوظيفي: *${pendingFinance.employeeNo}*\n` +
                                `💰 النوع: *${pendingFinance.action}*\n` +
                                `💵 المبلغ: *${formattedAmount} ريال*\n` +
                                (pendingFinance.description
                                    ? `📝 البيان: ${pendingFinance.description}\n`
                                    : '') +
                                `🧾 رقم العملية: *${transaction.transaction_no}*\n\n` +
                                `💚 *لك: ${formattedCredit} ريال*\n` +
                                `🔴 *عليك: ${formattedDebit} ريال*\n` +
                                balanceLine
                            );

                            const employeePhone =
                                String(pendingFinance.employeePhone || '')
                                    .replace(/\D/g, '');

                            if (employeePhone.length >= 9) {
                                const notificationText =
                                `🔔 *إشعار مالي من ملوك التنجيد*\n\n` +
                                `تم تسجيل عملية *${pendingFinance.action}* للموظف *${pendingFinance.employeeName}* بمبلغ *${formattedAmount} ريال*.\n\n` +
                                `شكرًا لك، ملوك التنجيد 👑`;
                            await sendTemplateMessage(
                                employeePhone,
                                'employee_finance_notification',
                                'ar',
                                [
                                    pendingFinance.action,
                                    pendingFinance.employeeName,
                                    formattedAmount
                                ]
                            );
                            }

                            console.log(
                                'Confirmed central employee financial transaction:',
                                transaction
                            );

                            continue;
                        } catch (error) {
                            console.error(
                                'Central employee finance confirmation error:',
                                error.message
                            );

                            await sendTextMessage(
                                from,
                                '❌ حدث خطأ أثناء تسجيل العملية.\n\n' +
                                'لم يتم تأكيد العملية، حاول مرة أخرى.'
                            );

                            continue;
                        }
                    }

                    const interactiveMap = {
                        booking: 'BOOKING',
                        prices: 'PRICES',
                        address: 'ADDRESS',
                        staff: 'STAFF',
                        staff_call: 'STAFF_CALL',
                        staff_whatsapp: 'STAFF_WHATSAPP',
                        warranty: 'WARRANTY',
                        employee: 'EMPLOYEE',

                        category_sedan: 'CATEGORY_SEDAN',
                        category_suv: 'CATEGORY_SUV',

                        start_real_booking: 'START_REAL_BOOKING',
                        show_catalog_again: 'SHOW_CATALOG_AGAIN',

                        service_seats: 'SERVICE_seats',
                        service_floor: 'SERVICE_floor',
                        service_full_interior: 'SERVICE_full_interior',
                        service_roof: 'SERVICE_roof',
                        service_decor: 'SERVICE_decor',
                        service_dashboard: 'SERVICE_dashboard',
                        service_done: 'SERVICE_DONE',

                        add_more_service: 'ADD_MORE_SERVICE',
                        remove_service: 'REMOVE_SERVICE',
                        finish_services: 'FINISH_SERVICES',

                        confirm_booking: 'CONFIRM_BOOKING',
                        cancel_booking: 'CANCEL_BOOKING'
                    };

                    if (selectedId.startsWith('remove_selected_')) {
                        text = selectedId;
                    }

                    if (selectedId === 'remove_service') {
                        text = 'REMOVE_SERVICE';
                    }

                    if (selectedId.startsWith('variant_')) {
                        text = selectedId;
                    }

                    else if (selectedId.startsWith('booking_day_')) {
                        const bookingDate =
                            selectedId
                                .replace('booking_day_', '')
                                .replace(/_/g, '-');

                        text = `BOOKING_DATE:${bookingDate}`;
                    }

                    else {
                        text =
                            interactiveMap[selectedId] ||
                            selectedId ||
                            '';
                    }

                    console.log(
                        'Interactive selection:',
                        {
                            id: selectedId,
                            mappedTo: text
                        }
                    );
                }

                else {
                    continue;
                }

                if (!text) continue;

                let chatDisplayText = text;

                if (message.type === 'text') {
                    chatDisplayText =
                        message.text?.body?.trim() ||
                        text;
                } else if (message.type === 'interactive') {
                    chatDisplayText =
                        message.interactive?.list_reply?.title ||
                        message.interactive?.button_reply?.title ||
                        message.interactive?.nfm_reply?.name ||
                        text;
                }

                await saveIncomingWhatsAppMessage({
                    from,
                    customerName,
                    message,
                    displayText: chatDisplayText
                });


/*
|--------------------------------------------------------------------------
| تأكيد / رفض طلب الحجز من الرقم المركزي
|--------------------------------------------------------------------------
*/

/*
|--------------------------------------------------------------------------
| اعتماد / رفض إشعار تحويل العربون من الرقم المركزي
|--------------------------------------------------------------------------
*/
console.log('PAYMENT PROOF DEBUG:', {
    from,
    central: CENTRAL_FINANCE_PHONE,
    type: message.type,
    text,
    selectedId: message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '',
    interactiveType: message.interactive?.type || ''
});

if (
    message.type === 'interactive' &&
    from === CENTRAL_FINANCE_PHONE &&
    (
        /^payment_proof_confirm_\d+$/i.test(text) ||
        /^payment_proof_reject_\d+$/i.test(text)
    )
) {
    try {
        const confirmProofMatch =
            text.match(/^payment_proof_confirm_(\d+)$/i);

        const rejectProofMatch =
            text.match(/^payment_proof_reject_(\d+)$/i);

        const bookingId = Number(
            confirmProofMatch?.[1] ||
            rejectProofMatch?.[1]
        );

        if (!bookingId) {
            await sendTextMessage(
                from,
                '⚠️ رقم الحجز غير صالح.'
            );
            continue;
        }

        const bookingResult = await pool.query(
            `
            SELECT
                id,
                booking_no,
                whatsapp_from,
                customer_name,
                car_type,
                model_year,
                service,
                branch,
                status,
                payment_proof_status
            FROM whatsapp_bookings
            WHERE id = $1
            LIMIT 1
            `,
            [bookingId]
        );

        if (!bookingResult.rows.length) {
            await sendTextMessage(
                from,
                '❌ الحجز غير موجود.'
            );
            continue;
        }

        const booking = bookingResult.rows[0];

        if (confirmProofMatch) {
            if (
                booking.status !== 'PENDING_DEPOSIT' ||
                booking.payment_proof_status !== 'PENDING_REVIEW'
            ) {
                await sendTextMessage(
                    from,
                    `⚠️ الحجز ${booking.booking_no} لم يعد لديه إثبات تحويل بانتظار المراجعة.`
                );
                continue;
            }

            const approved = await pool.query(
                `
                UPDATE whatsapp_bookings
                SET payment_proof_status = 'CONFIRMED'
                WHERE id = $1
                  AND status = 'PENDING_DEPOSIT'
                  AND payment_proof_status = 'PENDING_REVIEW'
                RETURNING
                    id,
                    booking_no,
                    whatsapp_from,
                    customer_name,
                    car_type,
                    model_year,
                    service,
                    branch
                `,
                [bookingId]
            );

            if (!approved.rows.length) {
                await sendTextMessage(
                    from,
                    '⚠️ تعذر اعتماد الإيصال، ربما تمت معالجته مسبقًا.'
                );
                continue;
            }

            const approvedBooking = approved.rows[0];

            bookingSessions.set(
                approvedBooking.whatsapp_from,
                {
                    step: 'DAY',
                    pendingBookingId: approvedBooking.id,
                    pendingBookingNo: approvedBooking.booking_no
                }
            );

            await sendTextMessage(
                approvedBooking.whatsapp_from,
                '✅ *تم اعتماد العربون* 👑\n\n' +
                `🔢 *رقم الطلب:* ${approvedBooking.booking_no}\n` +
                `🚗 *السيارة:* ${approvedBooking.car_type || ''}\n` +
                `🚘 *سنة الموديل:* ${approvedBooking.model_year || ''}\n\n` +
                '💳 تم اعتماد إشعار التحويل بنجاح.\n\n' +
                '📅 الآن اختر اليوم المناسب لك من المواعيد المتاحة أدناه.\n\n' +
                '⚠️ سيتم تثبيت الحجز بعد اختيار الموعد.'
            );

            await sendAvailableDaysMenu(
                approvedBooking.whatsapp_from
            );

            await sendTextMessage(
                from,
                `✅ تم اعتماد العربون للحجز *${approvedBooking.booking_no}*.\n` +
                '📅 تم إرسال المواعيد المتاحة للعميل.'
            );

            console.log(
                'Payment proof approved:',
                approvedBooking.booking_no,
                approvedBooking.whatsapp_from
            );

            continue;
        }

        if (rejectProofMatch) {
            if (
                booking.status !== 'PENDING_DEPOSIT' ||
                booking.payment_proof_status !== 'PENDING_REVIEW'
            ) {
                await sendTextMessage(
                    from,
                    `⚠️ الحجز ${booking.booking_no} لم يعد لديه إثبات تحويل بانتظار المراجعة.`
                );
                continue;
            }

            const rejected = await pool.query(
                `
                UPDATE whatsapp_bookings
                SET
                    payment_proof_status = 'NOT_RECEIVED',
                    payment_proof_media_id = NULL,
                    payment_proof_received_at = NULL
                WHERE id = $1
                  AND status = 'PENDING_DEPOSIT'
                  AND payment_proof_status = 'PENDING_REVIEW'
                RETURNING
                    id,
                    booking_no,
                    whatsapp_from
                `,
                [bookingId]
            );

            if (!rejected.rows.length) {
                await sendTextMessage(
                    from,
                    '⚠️ تعذر رفض الإيصال، ربما تمت معالجته مسبقًا.'
                );
                continue;
            }

            const rejectedBooking = rejected.rows[0];

            bookingSessions.delete(
                rejectedBooking.whatsapp_from
            );

            await sendTextMessage(
                rejectedBooking.whatsapp_from,
                '⚠️ *تعذر اعتماد إشعار التحويل*.\n\n' +
                `🔢 *رقم الطلب:* ${rejectedBooking.booking_no}\n\n` +
                'يرجى إرسال صورة واضحة وصحيحة لإشعار التحويل مرة أخرى.'
            );

            await sendTextMessage(
                from,
                `❌ تم رفض إشعار التحويل للحجز *${rejectedBooking.booking_no}*.\n` +
                '📸 تم طلب إعادة إرسال الإيصال من العميل.'
            );

            console.log(
                'Payment proof rejected:',
                rejectedBooking.booking_no,
                rejectedBooking.whatsapp_from
            );

            continue;
        }

    } catch (paymentReviewError) {
        console.error(
            'Payment proof review error:',
            paymentReviewError.response?.data ||
            paymentReviewError.message
        );

        await sendTextMessage(
            from,
            '⚠️ حدث خطأ أثناء معالجة إشعار التحويل.'
        );

        continue;
    }
}

if (
    message.type === 'interactive' &&
    from === CENTRAL_FINANCE_PHONE &&
    (
        /^booking_request_confirm_\d+$/i.test(text) ||
        /^booking_request_cancel_\d+$/i.test(text)
    )
) {
    try {
        const confirmMatch = text.match(/^booking_request_confirm_(\d+)$/i);
        const cancelMatch = text.match(/^booking_request_cancel_(\d+)$/i);

        const bookingId = Number(
            confirmMatch?.[1] || cancelMatch?.[1]
        );

        if (!bookingId) {
            await sendTextMessage(
                from,
                '⚠️ رقم طلب الحجز غير صالح.'
            );
            continue;
        }

        const bookingResult = await pool.query(
            `
            SELECT
                id,
                booking_no,
                whatsapp_from,
                customer_name,
                car_type,
                model_year,
                service,
                branch,
                status
            FROM whatsapp_bookings
            WHERE id = $1
            LIMIT 1
            `,
            [bookingId]
        );

        if (!bookingResult.rows.length) {
            await sendTextMessage(
                from,
                '❌ طلب الحجز غير موجود.'
            );
            continue;
        }

        const booking = bookingResult.rows[0];

        if (confirmMatch) {
            if (booking.status !== 'PENDING') {
                await sendTextMessage(
                    from,
                    `⚠️ الطلب ${booking.booking_no} لم يعد في حالة انتظار التأكيد.`
                );
                continue;
            }

            const updated = await pool.query(
                `
                UPDATE whatsapp_bookings
                SET
                    status = 'PENDING_DEPOSIT',
                    payment_proof_status = 'NOT_RECEIVED'
                WHERE id = $1
                  AND status = 'PENDING'
                RETURNING
                    id,
                    booking_no,
                    whatsapp_from,
                    customer_name,
                    car_type,
                    model_year,
                    service,
                    branch
                `,
                [bookingId]
            );

            if (!updated.rows.length) {
                await sendTextMessage(
                    from,
                    '⚠️ تعذر تأكيد الطلب، ربما تم التعامل معه مسبقًا.'
                );
                continue;
            }

            const confirmedBooking = updated.rows[0];

            await sendTextMessage(
                confirmedBooking.whatsapp_from,
                `✅ *تم تأكيد طلبك* 👑

` +
                `🔢 *رقم الطلب:* ${confirmedBooking.booking_no}

` +
                `👤 *الاسم:* ${confirmedBooking.customer_name || ''}

` +
                `🚗 *السيارة:* ${confirmedBooking.car_type || ''}

` +
                `🚘 *سنة الموديل:* ${confirmedBooking.model_year || ''}

` +
                `📍 *المحافظة:* ${confirmedBooking.branch || ''}

` +
                `🧰 *الخدمات:* ${confirmedBooking.service || ''}

` +
                `💳 *الخطوة التالية:*
يرجى تحويل عربون الحجز ثم إرسال صورة إشعار التحويل هنا عبر واتساب.

` +
                `⏳ بعد إرسال صورة التحويل سيتم إيقاف الردود الآلية المتعلقة بالحجز حتى تتم مراجعة العربون وتأكيد الحجز.

` +
                `🙏 شكرًا لاختيارك *ملوك التنجيد* 👑🚗`
            );

            await sendTextMessage(
                from,
                `✅ تم تأكيد الطلب *${confirmedBooking.booking_no}*.

تم إشعار العميل بضرورة تحويل العربون وإرسال صورة إشعار التحويل.`
            );

            console.log(
                'Booking request confirmed:',
                confirmedBooking.booking_no,
                confirmedBooking.whatsapp_from
            );

            continue;
        }

        if (cancelMatch) {
            if (booking.status !== 'PENDING') {
                await sendTextMessage(
                    from,
                    `⚠️ الطلب ${booking.booking_no} لم يعد في حالة انتظار التأكيد.`
                );
                continue;
            }

            const cancelled = await pool.query(
                `
                UPDATE whatsapp_bookings
                SET status = 'CANCELLED'
                WHERE id = $1
                  AND status = 'PENDING'
                RETURNING booking_no, whatsapp_from
                `,
                [bookingId]
            );

            if (!cancelled.rows.length) {
                await sendTextMessage(
                    from,
                    '⚠️ تعذر إلغاء الطلب، ربما تم التعامل معه مسبقًا.'
                );
                continue;
            }

            await sendTextMessage(
                cancelled.rows[0].whatsapp_from,
                `❌ *نعتذر، لم يتم قبول طلب الحجز*.

` +
                `🔢 *رقم الطلب:* ${cancelled.rows[0].booking_no}

` +
                `يمكنك التواصل مع ملوك التنجيد لمزيد من المعلومات.`
            );

            await sendTextMessage(
                from,
                `❌ تم رفض الطلب *${cancelled.rows[0].booking_no}* وإشعار العميل.`
            );

            console.log(
                'Booking request cancelled:',
                cancelled.rows[0].booking_no
            );

            continue;
        }

    } catch (error) {
        console.error(
            'Booking request confirmation error:',
            error.response?.data || error.message
        );

        await sendTextMessage(
            from,
            '❌ حدث خطأ أثناء معالجة طلب الحجز.'
        );

        continue;
    }
}

                const normalizedText =
                    normalizeText(text);

                /*
                |--------------------------------------------------------------------------
                | تقييم العميل داخل WhatsApp
                |--------------------------------------------------------------------------
                */
                if (
                    message.type === 'interactive' &&
                    /^rating_[1-5]_MK-(?:WO-)?\d{4}-\d{6}$/i.test(text)
                ) {
                    try {
                        const ratingMatch = text.match(
                            /^rating_([1-5])_(MK-(?:WO-)?\d{4}-\d{6})$/i
                        );

                        const rating = Number(ratingMatch[1]);
                        const orderNo = ratingMatch[2];

                        const customerResult = await pool.query(
                            `SELECT
                                wo.work_order_id,
                                wo.work_order_no,
                                c.customer_id,
                                c.full_name
                             FROM work_orders wo
                             JOIN customers c
                               ON c.customer_id = wo.customer_id
                             WHERE UPPER(wo.work_order_no) = UPPER($1)
                               AND regexp_replace(c.phone, '\\D', '', 'g') = $2
                             LIMIT 1`,
                            [orderNo, String(from).replace(/\D/g, '')]
                        );

                        if (!customerResult.rows.length) {
                            await sendTextMessage(
                                from,
                                '❌ لم نتمكن من ربط التقييم بأمر التشغيل.'
                            );
                            continue;
                        }

                        const workOrder = customerResult.rows[0];

                        const existingRating = await pool.query(
                            `SELECT rating_id
                             FROM customer_ratings
                             WHERE work_order_id = $1
                             LIMIT 1`,
                            [workOrder.work_order_id]
                        );

                        if (existingRating.rows.length) {
                            await sendTextMessage(
                                from,
                                'ℹ️ تم تسجيل تقييم هذا الأمر مسبقًا. شكرًا لك ❤️'
                            );
                            continue;
                        }

                        await pool.query(
                            `INSERT INTO customer_ratings
                                (work_order_id, customer_id, rating)
                             VALUES ($1, $2, $3)`,
                            [
                                workOrder.work_order_id,
                                workOrder.customer_id,
                                rating
                            ]
                        );

                        await sendTextMessage(
                            from,
                            `❤️ *شكرًا لتقييمك*\n\n` +
                            `تم تسجيل تقييمك لأمر التشغيل *${workOrder.work_order_no}* بنجاح.\n\n` +
                            `تقييمك: *${'⭐'.repeat(rating)}*\n\n` +
                            `📝 هل لديك ملاحظة أو اقتراح؟\n` +
                            `يمكنك كتابة ملاحظتك أو إرسال *لا يوجد*.`
                        );

                        continue;

                    } catch (error) {
                        console.error(
                            'WhatsApp customer rating error:',
                            error
                        );

                        await sendTextMessage(
                            from,
                            '❌ حدث خطأ أثناء حفظ التقييم، حاول مرة أخرى.'
                        );

                        continue;
                    }
                }

                /*
                |--------------------------------------------------------------------------
                | إنشاء أمر تشغيل للموظف عبر WhatsApp — الرقم المركزي فقط
                |--------------------------------------------------------------------------
                */
                if (
                    from === CENTRAL_FINANCE_PHONE &&
                    message.type === 'text' &&
                    /^#EMP\b/i.test(text)
                ) {
                    try {
                        const employeeOrderData =
                            parseEmployeeWorkOrderMessage(text);

                        const employee =
                            await findEmployeeForEmployeeOrder(
                                employeeOrderData.employee
                            );

                        const employeeOrder =
                            await createEmployeeWorkOrder(
                                employeeOrderData,
                                employee
                            );

                        await sendTextMessage(
                            from,
                            `✅ *تم إنشاء أمر تشغيل للموظف بنجاح*\n\n` +
                            `🧾 رقم الأمر: *${employeeOrder.work_order_no}*\n` +
                            `👷 الموظف: *${employeeOrder.employeeName}*\n` +
                            `🚗 السيارة: *${employeeOrder.vehicle.make} ${employeeOrder.vehicle.model} ${employeeOrder.vehicle.model_year}*\n` +
                            `🔧 العمل: *${employeeOrder.work}*\n` +
                            `💰 قيمة العمل: *${Number(employeeOrder.amount).toLocaleString('en-US')} ريال*\n` +
                            `📅 التاريخ: *${employeeOrder.workDate}*`
                        );

                        continue;
                    } catch (error) {
                        console.error(
                            'WhatsApp #EMP work order error:',
                            error
                        );

                        await sendTextMessage(
                            from,
                            `❌ *تعذر إنشاء أمر تشغيل الموظف*\n\n` +
                            `${error.message || 'حدث خطأ غير متوقع.'}`
                        );

                        continue;
                    }
                }

                /*
                |--------------------------------------------------------------------------
                | إنشاء أمر تشغيل عبر WhatsApp — الرقم المركزي فقط
                |--------------------------------------------------------------------------
                */

                if (
                    from === CENTRAL_FINANCE_PHONE &&
                    message.type === 'text' &&
                    /^تسوية\s+MK-(?:WO-)?\d{4}-\d{6}$/i.test(text.trim())
                ) {
                    try {
                        const orderNo = text.trim().split(/\s+/)[1].toUpperCase();

                        const result = await pool.query(
                            `SELECT
                                wo.work_order_id,
                                wo.work_order_no,
                                ep.piecework_id,
                                ep.employee_id,
                                ep.work_description,
                                ep.amount,
                                ep.status,
                                e.full_name
                             FROM work_orders wo
                             JOIN employee_piecework ep
                               ON ep.work_order_id = wo.work_order_id
                             JOIN employees e
                               ON e.employee_id = ep.employee_id
                             WHERE UPPER(wo.work_order_no) = UPPER($1)
                             ORDER BY ep.piecework_id DESC
                             LIMIT 1`,
                            [orderNo]
                        );

                        if (!result.rows.length) {
                            await sendTextMessage(
                                from,
                                `❌ لا يوجد مستحق موظف مرتبط بأمر التشغيل *${orderNo}*.`
                            );
                            continue;
                        }

                        const piecework = result.rows[0];

                        if (piecework.status !== 'DUE') {
                            await sendTextMessage(
                                from,
                                `ℹ️ هذا المستحق ليس في حالة مستحق للدفع.\n\n` +
                                `🧾 الأمر: *${orderNo}*\\n` +
                                `👷 الموظف: *${piecework.full_name}*\\n` +
                                `📌 الحالة: *${piecework.status}*`
                            );
                            continue;
                        }

                        const transaction =
                            await createEmployeeFinancialTransaction({
                                employeeId: piecework.employee_id,
                                amount: piecework.amount,
                                direction: 'DEBIT',
                                transactionType: 'SETTLEMENT',
                                workOrderId: piecework.work_order_id,
                                pieceworkId: piecework.piecework_id,
                                description:
                                    `تسوية مستحق أمر التشغيل ${piecework.work_order_no}`,
                                from
                            });

                        await pool.query(
                            `UPDATE employee_piecework
                             SET status = 'PAID',
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE piecework_id = $1
                               AND employee_id = $2
                               AND status = 'DUE'`,
                            [piecework.piecework_id, piecework.employee_id]
                        );

                        await sendTextMessage(
                            from,
                            `✅ *تمت تسوية مستحق الموظف*\n\n` +
                            `🧾 أمر التشغيل: *${piecework.work_order_no}*\n` +
                            `👷 الموظف: *${piecework.full_name}*\n` +
                            `🔧 العمل: *${piecework.work_description}*\n` +
                            `💰 مبلغ التسوية: *${Number(piecework.amount).toLocaleString('en-US')} ريال*\n` +
                            `💳 رقم الحركة: *${transaction.transaction_no}*\n` +
                            `📌 الحالة: *تم الدفع*`
                        );

                        continue;
                    } catch (error) {
                        console.error('WhatsApp settlement error:', error);
                        await sendTextMessage(
                            from,
                            `❌ *تعذر تنفيذ التسوية*\\n\\n${error.message || 'حدث خطأ غير متوقع.'}`
                        );
                        continue;
                    }
                }

                if (
                    from === CENTRAL_FINANCE_PHONE &&
                    message.type === 'text' &&
                    /^#NEW\b/i.test(text)
                ) {
                    try {
                        const newOrderData =
                            parseNewWorkOrderMessage(text);

                        const newOrder =
                            await createWorkOrderFromWhatsApp(
                                newOrderData
                            );

                        await sendTextMessage(
                            from,
                            `✅ *تم إنشاء أمر التشغيل بنجاح*\n\n` +
                            `🧾 رقم الأمر: *${newOrder.work_order_no}*\n` +
                            `👤 العميل: *${newOrder.customerName}*\n` +
                            `🚗 السيارة: *${newOrder.vehicle.raw}*\n\n` +
                            `💰 الإجمالي: *${Number(newOrder.total).toLocaleString('en-US')} ريال*\n` +
                            `💵 العربون: *${Number(newOrder.deposit).toLocaleString('en-US')} ريال*\n` +
                            `🔴 المتبقي: *${Number(newOrder.balance).toLocaleString('en-US')} ريال*`
                        );

                        const customerPhone =
                            String(newOrder.customerPhone || '')
                                .replace(/\D/g, '');

                        if (
                            customerPhone &&
                            customerPhone !== CENTRAL_FINANCE_PHONE
                        ) {
                            await sendTextMessage(
                                customerPhone,
                                `✅ *تم تسجيل أمر التشغيل لدى ملوك التنجيد*\n\n` +
                                `🧾 رقم الأمر: *${newOrder.work_order_no}*\n` +
                                `🚗 السيارة: *${newOrder.vehicle.raw}*\n\n` +
                                `💰 الإجمالي: *${Number(newOrder.total).toLocaleString('en-US')} ريال*\n` +
                                `💵 العربون: *${Number(newOrder.deposit).toLocaleString('en-US')} ريال*\n` +
                                `🔴 المتبقي: *${Number(newOrder.balance).toLocaleString('en-US')} ريال*\n\n` +
                                `📌 الحالة: *جديد*\n\n` +
                                `📲 يمكنك إرسال رقم أمر التشغيل في أي وقت لمعرفة حالة سيارتك.`
                            );
                        }

                        continue;

                    } catch (error) {
                        console.error(
                            'WhatsApp #NEW work order error:',
                            error
                        );

                        await sendTextMessage(
                            from,
                            `❌ *تعذر إنشاء أمر التشغيل*\n\n` +
                            `${error.message || 'حدث خطأ غير متوقع.'}`
                        );

                        continue;
                    }
                }

                /*
                |--------------------------------------------------------------------------
                | استعلام العميل عن أمر التشغيل برقم الأمر
                |--------------------------------------------------------------------------
                */

                /*
                |--------------------------------------------------------------------------
                | تحديث مرحلة أمر التشغيل من رقم المركز
                |--------------------------------------------------------------------------
                */

                if (
                    from === CENTRAL_FINANCE_PHONE &&
                    message.type === 'text'
                ) {
                    const stageUpdateMatch = text.match(
                        /^(MK-(?:WO-)?\d{4}-\d{6})\s+(.+)$/i
                    );

                    if (stageUpdateMatch) {
                        try {
                            const orderNo = stageUpdateMatch[1];
                            const stageText = stageUpdateMatch[2].trim();

                            const updatedStage =
                                await updateWorkOrderStageFromWhatsApp(
                                    orderNo,
                                    stageText
                                );

                            await sendTextMessage(
                                from,
                                `✅ *تم تحديث مرحلة أمر التشغيل*\n\n` +
                                `🧾 رقم الأمر: *${updatedStage.workOrderNo}*\n` +
                                `🔧 المرحلة: *${updatedStage.stage.stage_name}*\n` +
                                `📌 الحالة: *مكتملة*`
                            );

                            const customerPhone =
                                String(updatedStage.customerPhone || '')
                                    .replace(/\D/g, '');

                            if (
                                customerPhone &&
                                customerPhone !== CENTRAL_FINANCE_PHONE
                            ) {
                                await sendTextMessage(
                                    customerPhone,
                                    `🔔 *تم تحديث حالة سيارتك*\n\n` +
                                    `🧾 أمر التشغيل: *${updatedStage.workOrderNo}*\n` +
                                    `🔧 المرحلة: *${updatedStage.stage.stage_name}*\n` +
                                    `📌 الحالة: *مكتملة*\n\n` +
                                    `شكرًا لاختياركم ملوك التنجيد 👑`
                                );

                                if (
                                    updatedStage.stage.stage_name === 'إغلاق أمر العمل'
                                ) {
                                    await sendCustomerRatingRequest(
                                        customerPhone,
                                        updatedStage.workOrderNo
                                    );
                                }
                            }

                            continue;

                        } catch (error) {
                            console.error(
                                'WhatsApp stage update error:',
                                error
                            );

                            await sendTextMessage(
                                from,
                                `❌ *تعذر تحديث مرحلة أمر التشغيل*\n\n` +
                                `${error.message || 'حدث خطأ غير متوقع.'}`
                            );

                            continue;
                        }
                    }
                }


                if (
                    from !== CENTRAL_FINANCE_PHONE &&
                    message.type === 'text' &&
                    /^MK-(?:WO-)?\d{4}-\d{6}$/i.test(text)
                ) {
                    try {
                        const workOrder =
                            await getWorkOrderForCustomer(text, from);

                        if (!workOrder) {
                            await sendTextMessage(
                                from,
                                `⚠️ لم يتم العثور على أمر تشغيل بهذا الرقم.\n\n` +
                                `تأكد من رقم الأمر وأنك ترسله من رقم الجوال المسجل في الأمر.`
                            );

                            continue;
                        }

                        const statusMap = {
                            NEW: 'جديد',
                            INSPECTION: 'قيد المعاينة',
                            WAITING_CUSTOMER_APPROVAL: 'بانتظار اعتماد العميل',
                            APPROVED: 'تم الاعتماد',
                            IN_PROGRESS: 'قيد التنفيذ',
                            QUALITY_CHECK: 'الفحص النهائي',
                            CORRECTION_REQUIRED: 'يحتاج إلى تصحيح',
                            READY_FOR_DELIVERY: 'جاهز للتسليم',
                            DELIVERED: 'تم التسليم',
                            CLOSED: 'مغلق',
                            CANCELLED: 'ملغي'
                        };

                        const statusText =
                            statusMap[workOrder.status] ||
                            workOrder.status;

                        const stageText =
                            workOrder.current_stage ||
                            'لم تبدأ مرحلة محددة بعد';

                        const total =
                            Number(workOrder.total_amount || 0)
                                .toLocaleString('en-US');

                        const deposit =
                            Number(workOrder.deposit_amount || 0)
                                .toLocaleString('en-US');

                        const balance =
                            Number(workOrder.balance_amount || 0)
                                .toLocaleString('en-US');

                        const vehicle =
                            [
                                workOrder.make,
                                workOrder.model,
                                workOrder.model_year
                            ]
                            .filter(Boolean)
                            .join(' ');

                        await sendTextMessage(
                            from,
                            `🧾 *أمر التشغيل*\n\n` +
                            `رقم الأمر: *${workOrder.work_order_no}*\n` +
                            `👤 العميل: *${workOrder.customer_name}*\n` +
                            `🚗 السيارة: *${vehicle || 'غير محددة'}*\n\n` +
                            `📌 الحالة: *${statusText}*\n` +
                            `🔧 المرحلة الحالية: *${stageText}*\n\n` +
                            `💰 الإجمالي: *${total} ريال*\n` +
                            `💵 العربون: *${deposit} ريال*\n` +
                            `🔴 المتبقي: *${balance} ريال*`
                        );

                        continue;

                    } catch (error) {
                        console.error(
                            'WhatsApp work order lookup error:',
                            error
                        );

                        await sendTextMessage(
                            from,
                            '❌ حدث خطأ أثناء الاستعلام عن أمر التشغيل.'
                        );

                        continue;
                    }
                }


                if (
                    !WHATSAPP_AUTO_REPLY_ENABLED &&
                    from !== CENTRAL_FINANCE_PHONE
                ) {
                    continue;
                }

                let session =
                    bookingSessions.get(from);

                /*
                |--------------------------------------------------------------------------
                | حماية مراحل الحجز التي تعتمد على القوائم
                |--------------------------------------------------------------------------
                */

                if (
                    session &&
                    message.type === 'text' &&
                    ['SERVICES', 'VARIANT', 'REMOVE_SERVICE', 'DAY', 'CONFIRM']
                        .includes(session.step)
                ) {
                    await sendTextMessage(
                        from,
                        '⚠️ لم أفهم اختيارك.\n\n' +
                        'الرجاء تحديد اختيارك من القائمة المرسلة.'
                    );

                    if (session.step === 'SERVICES') {
                        await sendServiceMenu(from, session);

                    } else if (session.step === 'VARIANT') {
                        const pendingServices =
                            Array.isArray(session.pendingVariantServices)
                                ? session.pendingVariantServices
                                : [];

                        const currentIndex =
                            Number(session.variantIndex || 0);

                        const serviceId =
                            pendingServices[currentIndex] ||
                            session.pendingService;

                        if (serviceId) {
                            await sendVariantMenu(
                                from,
                                session,
                                serviceId
                            );
                        } else {
                            await sendServiceMenu(from, session);
                        }

                    } else if (session.step === 'REMOVE_SERVICE') {
                        await sendRemoveServiceMenu(
                            from,
                            session
                        );

                    } else if (session.step === 'DAY') {
                        await sendAvailableDaysMenu(from);

                    } else if (session.step === 'CONFIRM') {
                        await sendConfirmationMenu(
                            from,
                            session
                        );
                    }

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | بدء الحجز
                |--------------------------------------------------------------------------
                */
                if (text === 'STAFF') {
    await sendTemplateMessage(
        from,
        'muluk_staff_call',
        'ar'
    );

    await sendUrlButtonMessage(
        from,
        '💬 *واتساب موظف ملوك التنجيد*\n\nاضغط الزر لفتح المحادثة مباشرة.',
        'فتح واتساب',
        'https://wa.me/967775772833'
    );

    continue;
}

                if (text === 'STAFF_CALL') {
                    await sendContactMessage(
                        from,
                        '+967775772833',
                        'موظف ملوك التنجيد'
                    );
                    continue;
                }

                if (text === 'STAFF_WHATSAPP') {
                    await sendUrlButtonMessage(
                        from,
                        '💬 *واتساب موظف ملوك التنجيد*\n\nاضغط الزر لفتح المحادثة مباشرة.',
                        'فتح واتساب',
                        'https://wa.me/967775772833'
                    );
                    continue;
                }

                if (text === 'ADDRESS') {
                    await sendAddressMenu(from);
                    continue;
                }

                if (text === 'location_main') {
                    await sendTextMessage(
                        from,
                        '📍 *ملوك التنجيد – الفرع الرئيسي*\n\n' +
                        'صنعاء – شارع الستين، جوار جسر مذبح، بجوار صالة أبراج دبي.\n\n' +
                        '🗺️ *فتح الموقع على الخريطة:*\n' +
                        'https://maps.app.goo.gl/uhZpCxN1WgNZTQva7?g_st=ac'
                    );
                    continue;
                }

                if (text === 'location_tunis') {
                    await sendTextMessage(
                        from,
                        '📍 *ملوك التنجيد – فرع شارع تونس*\n\n' +
                        'شارع تونس – الفتحة المقابلة لمخابز تونس الآلية، جوار الملكة للعطور وأدوات التجميل.\n\n' +
                        '🗺️ *فتح الموقع على الخريطة:*\n' +
                        'https://maps.app.goo.gl/xUeeVaNk9p1rABZU8?g_st=ac'
                    );
                    continue;
                }


                if (
                    text === 'book' ||
                    text === 'BOOKING' ||
                    normalizedText === 'booking' ||
                    normalizedText === 'حجز' ||
                    normalizedText.includes('موعد')
                ) {
                    bookingSessions.delete(from);
                    await sendOfferBookingFlow(from);
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | فئة سيدان
                |--------------------------------------------------------------------------
                */

                if (text === 'CATEGORY_SEDAN') {
                    session = {
                        step: 'MODEL',
                        carCategory: 'sedan',
                        carCategoryName: CATALOG.sedan.name,
                        selectedServices: []
                    };

                    bookingSessions.set(from, session);

                    await sendTextMessage(
                        from,
                        '🚘 *سيدان — مرحلتان*\n' +
                        'صف أمام + صف وسط\n\n' +
                        'ممتاز 👑\n\n' +
                        'قبل الحجز، هذه أسعار ومواصفات فئة السيدان.'
                    );

                    await sendCatalog(from, 'sedan');
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | فئة دفع رباعي
                |--------------------------------------------------------------------------
                */

                if (text === 'CATEGORY_SUV') {
                    session = {
                        step: 'MODEL',
                        carCategory: 'suv',
                        carCategoryName: CATALOG.suv.name,
                        selectedServices: []
                    };

                    bookingSessions.set(from, session);

                    await sendTextMessage(
                        from,
                        '🚙 *دفع رباعي — ثلاث مراحل*\n' +
                        'ثلاثة صفوف\n\n' +
                        'ممتاز 👑\n\n' +
                        'هذه أسعار ومواصفات فئة الدفع الرباعي.'
                    );

                    await sendCatalog(from, 'suv');
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | عرض الأسعار
                |--------------------------------------------------------------------------
                */

                if (text === 'PRICES') {
                    await sendCarCategoryMenu(from);
                    continue;
                }

                if (text === 'SHOW_CATALOG_AGAIN') {
                    if (session?.carCategory) {
                        await sendCatalog(from, session.carCategory);
                    } else {
                        await sendCarCategoryMenu(from);
                    }
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | بدء الحجز بعد الكتالوج
                |--------------------------------------------------------------------------
                */

                if (text === 'START_REAL_BOOKING') {
                    if (!session?.carCategory) {
                        await sendCarCategoryMenu(from);
                        continue;
                    }

                    session.step = 'MODEL';
                    bookingSessions.set(from, session);

                    await sendTextMessage(
                        from,
                        '🚗 ممتاز.\n\n' +
                        'الآن أرسل *نوع السيارة + الموديل* في رسالة واحدة.\n\n' +
                        'مثال: _تويوتا برادو_'
                    );

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | الموديل
                |--------------------------------------------------------------------------
                */

                if (session?.step === 'MODEL') {
                    if (!text.trim()) {
                        await sendTextMessage(
                            from,
                            '🚘 أرسل نوع السيارة + الموديل من فضلك.\n\n' +
                            'مثال: _تويوتا برادو_'
                        );
                        continue;
                    }

                    session.model = text.trim();
                    session.step = 'SERVICES';

                    bookingSessions.set(from, session);

                    await sendServiceMenu(from, session);
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | حماية اختيار الخدمات
                |--------------------------------------------------------------------------
                */

                if (
                    session?.step === 'SERVICES' &&
                    message.type === 'text' &&
                    text.trim()
                ) {
                    await sendTextMessage(
                        from,
                        '⚠️ لم أفهم اختيارك.\n\n' +
                        'الرجاء تحديد اختيارك من القائمة المرسلة.'
                    );

                    await sendServiceMenu(
                        from,
                        session
                    );

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | اختيار خدمة
                |--------------------------------------------------------------------------
                */

                if (
                    session?.step === 'SERVICES' &&
                    /^SERVICE_/.test(text)
                ) {
                    const serviceId =
                        text.replace('SERVICE_', '');

                    if (
                        !SERVICE_ORDER.includes(serviceId)
                    ) {
                        await sendServiceMenu(from, session);
                        continue;
                    }

                    session.pendingService = serviceId;
                    session.step = 'VARIANT';

                    bookingSessions.set(from, session);

                    await sendVariantMenu(
                        from,
                        session,
                        serviceId
                    );

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | اختيار النوع/الخامة
                |--------------------------------------------------------------------------
                */

                if (
                    session?.step === 'VARIANT' &&
                    text.startsWith('variant_')
                ) {
                    const variantPrefix = 'variant_';
                    const variantText = text.slice(variantPrefix.length);

                    const serviceId = SERVICE_ORDER
                        .filter(id =>
                            variantText === id ||
                            variantText.startsWith(id + '_')
                        )
                        .sort((a, b) => b.length - a.length)[0];

                    const variantId = serviceId
                        ? variantText.slice(serviceId.length + 1)
                        : '';

                    const catalog =
                        getCatalogForSession(session);

                    const service =
                        catalog?.services?.[serviceId];

                    const variant =
                        service?.variants?.find(
                            item => item.id === variantId
                        );

                    if (!service || !variant) {
                        await sendServiceMenu(
                            from,
                            session
                        );
                        continue;
                    }

                    if (
                        !Array.isArray(
                            session.selectedServices
                        )
                    ) {
                        session.selectedServices = [];
                    }

                    const duplicate =
                        session.selectedServices.some(
                            item =>
                                item.serviceId === serviceId
                        );

                    if (duplicate) {
                        session.selectedServices =
                            session.selectedServices.filter(
                                item =>
                                    item.serviceId !== serviceId
                            );
                    }

                    session.selectedServices.push({
                        serviceId,
                        serviceName: service.name,
                        variantId: variant.id,
                        variantName: variant.name,
                        price: variant.price,
                        specs: variant.specs,
                        warranty: variant.warranty || ''
                    });

                    session.pendingService = null;

                    const pendingServices =
                        Array.isArray(session.pendingVariantServices)
                            ? session.pendingVariantServices
                            : [];

                    const currentIndex =
                        Number(session.variantIndex || 0);

                    const nextIndex = currentIndex + 1;

                    if (nextIndex < pendingServices.length) {
                        session.variantIndex = nextIndex;
                        session.step = 'VARIANT';

                        bookingSessions.set(
                            from,
                            session
                        );

                        await sendVariantMenu(
                            from,
                            session,
                            pendingServices[nextIndex]
                        );

                        continue;
                    }

                    session.pendingVariantServices = [];
                    session.variantIndex = 0;
                    session.step = 'SERVICES';

                    bookingSessions.set(
                        from,
                        session
                    );

                    await sendContinueServicesMenu(
                        from,
                        session
                    );

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | إلغاء خدمة
                |--------------------------------------------------------------------------
                */

                if (text === 'REMOVE_SERVICE') {
                    if (!session || !session.selectedServices?.length) {
                        await sendTextMessage(
                            from,
                            '⚠️ لا توجد خدمات مسجلة لإلغائها.'
                        );
                        continue;
                    }

                    session.step = 'REMOVE_SERVICE';
                    bookingSessions.set(from, session);

                    await sendRemoveServiceMenu(
                        from,
                        session
                    );

                    continue;
                }

                if (
                    session?.step === 'REMOVE_SERVICE' &&
                    text.startsWith('remove_selected_')
                ) {
                    const index = Number(
                        text.replace('remove_selected_', '')
                    );

                    if (
                        !Number.isInteger(index) ||
                        !session.selectedServices[index]
                    ) {
                        await sendTextMessage(
                            from,
                            '⚠️ تعذر تحديد الخدمة.'
                        );

                        await sendRemoveServiceMenu(
                            from,
                            session
                        );

                        continue;
                    }

                    const removed = session.selectedServices[index];

                    session.selectedServices.splice(index, 1);

                    if (!session.selectedServices.length) {
                        session.step = 'SERVICES';
                        bookingSessions.set(from, session);

                        await sendTextMessage(
                            from,
                            `🗑️ تم إلغاء: ${removed.serviceName}\n\nلا توجد خدمات مختارة حاليًا.`
                        );

                        await sendServiceMenu(
                            from,
                            session
                        );

                        continue;
                    }

                    session.step = 'SERVICES';
                    bookingSessions.set(from, session);

                    const total = getSelectedTotal(session);

                    await sendTextMessage(
                        from,
                        `🗑️ تم إلغاء: ${removed.serviceName}\n` +
                        `${removed.variantName}\n\n` +
                        `💰 الإجمالي الجديد: *${formatMoney(total)}*`
                    );

                    await sendContinueServicesMenu(
                        from,
                        session
                    );

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | إضافة خدمة أخرى
                |--------------------------------------------------------------------------
                */

                if (
                    text === 'ADD_MORE_SERVICE'
                ) {
                    if (!session) {
                        await sendCarCategoryMenu(from);
                        continue;
                    }

                    session.step = 'SERVICES';
                    session.pendingVariantServices = [];
                    session.variantIndex = 0;

                    bookingSessions.set(
                        from,
                        session
                    );

                    await sendServiceMenu(
                        from,
                        session
                    );

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | إنهاء الخدمات
                |--------------------------------------------------------------------------
                */

                if (
                    text === 'FINISH_SERVICES' ||
                    text === 'SERVICE_DONE'
                ) {
                    if (
                        !session ||
                        !session.selectedServices?.length
                    ) {
                        await sendTextMessage(
                            from,
                            '⚠️ اختر خدمة واحدة على الأقل قبل المتابعة.'
                        );

                        if (session) {
                            session.step = 'SERVICES';
                            bookingSessions.set(from, session);
                            await sendServiceMenu(from, session);
                        }

                        continue;
                    }

                    session.step = 'DAY';
                    bookingSessions.set(from, session);

                    await sendAvailableDaysMenu(from);
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | اختيار اليوم
                |--------------------------------------------------------------------------
                */

                if (
                    session?.step === 'DAY' &&
                    text.startsWith('BOOKING_DATE:')
                ) {
                    const bookingDate =
                        text.replace(
                            'BOOKING_DATE:',
                            ''
                        );

                    if (
                        !/^\d{4}-\d{2}-\d{2}$/.test(
                            bookingDate
                        )
                    ) {
                        await sendAvailableDaysMenu(from);
                        continue;
                    }


                    /*
                     * حجز معتمد العربون وينتظر اختيار الموعد
                     */
                    if (
                        session?.pendingBookingId &&
                        session?.pendingBookingNo
                    ) {
                        const pendingBookingId = Number(session.pendingBookingId);

                        const pendingBranch = await assignBranch(bookingDate);

                        if (!pendingBranch) {
                            await sendTextMessage(
                                from,
                                '⚠️ هذا الموعد امتلأ للتو.\n\n' +
                                'يرجى اختيار يوم آخر.'
                            );

                            await sendAvailableDaysMenu(from);
                            continue;
                        }

                        const dateObject = new Date(
                            `${bookingDate}T00:00:00Z`
                        );

                        const dayLabel = formatArabicDate(dateObject);

                        const updatedBooking = await pool.query(
                            `
                            UPDATE whatsapp_bookings
                            SET
                                booking_date = $1,
                                booking_day = $2,
                                branch = $3,
                                status = 'CONFIRMED'
                            WHERE id = $4
                              AND whatsapp_from = $5
                              AND status = 'PENDING_DEPOSIT'
                              AND payment_proof_status = 'CONFIRMED'
                            RETURNING
                                id,
                                booking_no,
                                whatsapp_from,
                                customer_name,
                                car_type,
                                model_year,
                                service,
                                branch,
                                booking_day,
                                booking_date,
                                status
                            `,
                            [
                                bookingDate,
                                dayLabel,
                                pendingBranch,
                                pendingBookingId,
                                from
                            ]
                        );

                        if (!updatedBooking.rows.length) {
                            bookingSessions.delete(from);

                            await sendTextMessage(
                                from,
                                '⚠️ تعذر تثبيت الموعد.\n\n' +
                                'قد يكون الطلب قد تم التعامل معه مسبقًا أو لم يعد متاحًا.'
                            );

                            continue;
                        }

                        const confirmedBooking = updatedBooking.rows[0];

                        bookingSessions.delete(from);

                        await sendTextMessage(
                            from,
                            '🎉 *تم تأكيد حجزك بنجاح* 👑\n\n' +
                            `🔢 *رقم الطلب:* ${confirmedBooking.booking_no}\n` +
                            `🚗 *السيارة:* ${confirmedBooking.car_type || ''}\n` +
                            `🚘 *سنة الموديل:* ${confirmedBooking.model_year || ''}\n` +
                            `📅 *الموعد:* ${confirmedBooking.booking_day || confirmedBooking.booking_date || ''}\n` +
                            `📍 *الفرع:* ${confirmedBooking.branch || ''}\n\n` +
                            '💳 تم اعتماد العربون.\n' +
                            '📅 وتم تثبيت الموعد الذي اخترته.\n\n' +
                            '🙏 شكرًا لاختيارك *ملوك التنجيد* 👑🚗'
                        );

                        console.log(
                            'Booking appointment confirmed:',
                            confirmedBooking.booking_no,
                            confirmedBooking.whatsapp_from,
                            confirmedBooking.booking_date
                        );

                        continue;
                    }

                    const branch =
                        await assignBranch(
                            bookingDate
                        );

                    if (!branch) {
                        await sendTextMessage(
                            from,
                            '⚠️ هذا الموعد امتلأ للتو.\n\n' +
                            'يرجى اختيار يوم آخر.'
                        );

                        await sendAvailableDaysMenu(from);
                        continue;
                    }

                    const dateObject =
                        new Date(
                            `${bookingDate}T00:00:00Z`
                        );

                    session.bookingDate =
                        bookingDate;

                    session.dayLabel =
                        formatArabicDate(dateObject);

                    session.branch = branch;
                    session.step = 'CONFIRM';

                    bookingSessions.set(from, session);

                    await sendTextMessage(
                        from,
                        '⚠️ *تنبيه مهم*\n\n' +
                        'الموعد الذي اخترته هو *موعد مبدئي* وقد يتغير حسب ظروف العمل والمواعيد المتاحة.\n\n' +
                        '📞 سيتم تأكيد الموعد أو إبلاغكم بأي تغيير من قبل موظف *ملوك التنجيد*.'
                    );

                    await sendConfirmationMenu(
                        from,
                        session
                    );

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | الإلغاء
                |--------------------------------------------------------------------------
                */

                if (
                    text === 'CANCEL_BOOKING' ||
                    normalizedText.includes('الغاء') ||
                    normalizedText.includes('إلغاء')
                ) {
                    if (session) {
                        bookingSessions.delete(from);
                    }

                    await sendTextMessage(
                        from,
                        '❌ تم إلغاء الطلب.\n\n' +
                        'يمكنك البدء من جديد في أي وقت بكتابة *حجز*.'
                    );

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | التأكيد + العربون
                |--------------------------------------------------------------------------
                */

                if (
                    session?.step === 'CONFIRM' &&
                    text === 'CONFIRM_BOOKING'
                ) {
                    try {
                        /*
                        | إعادة فحص الفرع قبل الإدخال
                        | لمنع امتلاء الموعد بين الاختيار والتأكيد
                        */
                        const freshBranch =
                            await assignBranch(
                                session.bookingDate
                            );

                        if (!freshBranch) {
                            session.step = 'DAY';
                            session.branch = null;

                            bookingSessions.set(
                                from,
                                session
                            );

                            await sendTextMessage(
                                from,
                                '⚠️ نعتذر، الموعد امتلأ قبل اكتمال التأكيد.\n\n' +
                                'اختر يومًا آخر من المواعيد المتاحة.'
                            );

                            await sendAvailableDaysMenu(
                                from
                            );

                            continue;
                        }

                        session.branch =
                            freshBranch;

                        const total =
                            getSelectedTotal(session);

                        const deposit =
                            Math.ceil(total * 0.5);

                        const remaining =
                            total - deposit;

                        const bookingNo =
                            'WA-' +
                            new Date()
                                .toISOString()
                                .replace(
                                    /[-:TZ.]/g,
                                    ''
                                )
                                .slice(0, 14) +
                            '-' +
                            Math.floor(
                                Math.random() * 1000
                            );

                        const serviceText =
                            session.selectedServices
                                .map(item =>
                                    `${item.serviceName} — ${item.variantName} — ${formatMoney(item.price)}`
                                )
                                .join(' + ');

                        /*
                        | نحفظ السعر والإجمالي والعربون داخل service
                        | بدون الحاجة لتعديل بنية الجدول الحالية.
                        */
                        const savedService =
                            `${serviceText} | الإجمالي: ${formatMoney(total)} | العربون 50%: ${formatMoney(deposit)} | المتبقي: ${formatMoney(remaining)}`;

                        await pool.query(
                            `
                            INSERT INTO whatsapp_bookings
                            (
                                booking_no,
                                whatsapp_from,
                                car_type,
                                model_year,
                                service,
                                branch,
                                booking_day,
                                booking_time,
                                booking_date,
                                status
                            )
                            VALUES
                            ($1,$2,$3,$4,$5,$6,$7,NULL,$8,'PENDING_DEPOSIT')
                            `,
                            [
                                bookingNo,
                                from,
                                session.carCategoryName,
                                session.model,
                                savedService,
                                session.branch,
                                session.dayLabel,
                                session.bookingDate
                            ]
                        );

                        bookingSessions.delete(from);

                        await sendTextMessage(
                            from,
                            '⏳ *تم تسجيل طلب الحجز* 👑\n\n' +
                            `🔢 *رقم الطلب:* ${bookingNo}\n` +
                            `🚗 *فئة السيارة:* ${session.carCategoryName}\n` +
                            `🚘 *الموديل:* ${session.model}\n\n` +
                            `🧰 *الخدمات:*\n${selectedServiceText(session)}\n\n` +
                            `📅 *الموعد:* ${session.dayLabel}\n\n` +
                            `💰 *إجمالي العمل:* ${formatMoney(total)}\n` +
                            `💵 *العربون المطلوب 50%:* ${formatMoney(deposit)}\n` +
                            `💳 *المتبقي:* ${formatMoney(remaining)}\n\n` +
                            '⚠️ *مهم جدًا:*\n' +
                            'الحجز لا يعتبر مؤكدًا إلا بعد دفع العربون بنسبة 50%.\n\n' +
                            '📌 حالة الطلب الآن: *بانتظار دفع العربون*.\n\n' +
                            '💳 *الخطوة الأخيرة لتأكيد الحجز:*\n' +
                            `يرجى دفع العربون المطلوب: *${formatMoney(deposit)}*.\n\n` +
                            '📸 *بعد التحويل أرسل صورة إيصال التحويل هنا في نفس المحادثة.*\n\n' +
                            '📎 من واتساب اضغط علامة المرفقات ثم اختر الصورة وأرسلها.\n\n' +
                            '🔒 بعد إرسال الصورة سيتم إيقاف الردود تلقائيًا حتى يراجع الموظف إثبات التحويل ويعتمد الحجز.\n\n' +
                            '⚠️ أرسل صورة الإيصال فقط.\n\n' +
                            'شكرًا لاختيارك *ملوك التنجيد* 👑🚗'
                        );

                    } catch (dbError) {
                        console.error(
                            'Booking save error:',
                            dbError.message
                        );

                        await sendTextMessage(
                            from,
                            '⚠️ حدث خطأ أثناء حفظ طلب الحجز.\n\n' +
                            'يرجى التواصل مع موظف ملوك التنجيد.'
                        );
                    }

                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | الضمان
                |--------------------------------------------------------------------------
                */

                if (
                    text === 'WARRANTY' ||
                    normalizedText.includes('ضمان')
                ) {
                    await sendTextMessage(
                        from,
                        '🛡️ *ضمان ملوك التنجيد*\n\n' +
                        '🇩🇪 الجلود الألمانية: ضمان 5 سنوات\n' +
                        '🇺🇸 الجلود الأمريكية: ضمان 3 سنوات\n' +
                        '🇪🇺 الجلود الأوروبية: ضمان سنة واحدة\n' +
                        '👑 التغيير الداخلي الكامل: ضمان 5 سنوات\n' +
                        '🎨 رش الديكورات: ضمان 4 سنوات\n\n' +
                        'الضمان حسب الخدمة والخامة المستخدمة.'
                    );
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | موظف
                |--------------------------------------------------------------------------
                */

                if (
                    text === 'EMPLOYEE' ||
                    normalizedText.includes('موظف')
                ) {
                    await sendTextMessage(
                        from,
                        '👨‍💼 بالتأكيد.\n\n' +
                        'اكتب استفسارك بالتفصيل وسيتابع معك فريق ملوك التنجيد.'
                    );
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | الأسعار من القائمة
                |--------------------------------------------------------------------------
                */

                if (
                    text === 'PRICES' ||
                    normalizedText.includes('اسعار') ||
                    normalizedText.includes('سعر')
                ) {
                    await sendCarCategoryMenu(from);
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | التحية
                |--------------------------------------------------------------------------
                */

                if (
                    normalizedText.includes('السلام') ||
                    normalizedText.includes('مرحبا') ||
                    normalizedText.includes('اهلا') ||
                    normalizedText.includes('هلا')
                ) {
                    await sendInteractiveMenu(from, customerName);
                    continue;
                }

                /*
                |--------------------------------------------------------------------------
                | أي رسالة غير معروفة
                |--------------------------------------------------------------------------
                */

                await sendInteractiveMenu(from, customerName);
            }
        }
    }
}

module.exports = router;
