const express = require('express');
const pool = require('../../db');
const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();

/*
 * RISKS & OPPORTUNITIES - ISO 9001
 *
 * GET  /api/risks-opportunities
 * GET  /api/risks-opportunities/:id
 * POST /api/risks-opportunities
 * PATCH /api/risks-opportunities/:id
 */

// GET all risks and opportunities
router.get(
    '/',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    ro.risk_id,
                    ro.branch_id,
                    b.branch_name,
                    ro.title,
                    ro.description,
                    ro.type,
                    ro.probability,
                    ro.impact,
                    ro.risk_score,
                    ro.mitigation_action,
                    ro.responsible_employee_id,
                    e.full_name AS responsible_employee_name,
                    ro.due_date,
                    ro.status,
                    ro.created_by,
                    ro.created_at,
                    ro.updated_at
                FROM risks_opportunities ro
                LEFT JOIN branches b
                    ON b.branch_id = ro.branch_id
                LEFT JOIN employees e
                    ON e.employee_id = ro.responsible_employee_id
                ORDER BY ro.risk_id DESC
            `);

            res.json({
                success: true,
                count: result.rows.length,
                risks_opportunities: result.rows
            });

        } catch (error) {
            console.error('GET risks and opportunities error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch risks and opportunities'
            });
        }
    }
);

// GET one risk or opportunity
router.get(
    '/:id',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    ro.risk_id,
                    ro.branch_id,
                    b.branch_name,
                    ro.title,
                    ro.description,
                    ro.type,
                    ro.probability,
                    ro.impact,
                    ro.risk_score,
                    ro.mitigation_action,
                    ro.responsible_employee_id,
                    e.full_name AS responsible_employee_name,
                    ro.due_date,
                    ro.status,
                    ro.created_by,
                    ro.created_at,
                    ro.updated_at
                FROM risks_opportunities ro
                LEFT JOIN branches b
                    ON b.branch_id = ro.branch_id
                LEFT JOIN employees e
                    ON e.employee_id = ro.responsible_employee_id
                WHERE ro.risk_id = $1
            `, [req.params.id]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Risk or opportunity not found'
                });
            }

            res.json({
                success: true,
                risk_opportunity: result.rows[0]
            });

        } catch (error) {
            console.error('GET risk or opportunity error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch risk or opportunity'
            });
        }
    }
);

// CREATE risk or opportunity
router.post(
    '/',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const {
                branch_id,
                title,
                description,
                type,
                probability,
                impact,
                mitigation_action,
                responsible_employee_id,
                due_date,
                status = 'OPEN'
            } = req.body;

            if (!title || !type) {
                return res.status(400).json({
                    success: false,
                    message: 'title and type are required'
                });
            }

            if (!['RISK', 'OPPORTUNITY'].includes(type)) {
                return res.status(400).json({
                    success: false,
                    message: 'type must be RISK or OPPORTUNITY'
                });
            }

            if (
                probability !== undefined &&
                probability !== null &&
                (Number(probability) < 1 || Number(probability) > 5)
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'probability must be between 1 and 5'
                });
            }

            if (
                impact !== undefined &&
                impact !== null &&
                (Number(impact) < 1 || Number(impact) > 5)
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'impact must be between 1 and 5'
                });
            }

            const result = await pool.query(`
                INSERT INTO risks_opportunities (
                    branch_id,
                    title,
                    description,
                    type,
                    probability,
                    impact,
                    mitigation_action,
                    responsible_employee_id,
                    due_date,
                    status,
                    created_by
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11
                )
                RETURNING
                    risk_id,
                    branch_id,
                    title,
                    description,
                    type,
                    probability,
                    impact,
                    risk_score,
                    mitigation_action,
                    responsible_employee_id,
                    due_date,
                    status,
                    created_by,
                    created_at,
                    updated_at
            `, [
                branch_id || null,
                title,
                description || null,
                type,
                probability ?? null,
                impact ?? null,
                mitigation_action || null,
                responsible_employee_id || null,
                due_date || null,
                status,
                req.user.user_id
            ]);

            res.status(201).json({
                success: true,
                message: 'Risk or opportunity created successfully',
                risk_opportunity: result.rows[0]
            });

        } catch (error) {
            console.error('POST risk or opportunity error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to create risk or opportunity'
            });
        }
    }
);

// UPDATE risk or opportunity
router.patch(
    '/:id',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const {
                branch_id,
                title,
                description,
                type,
                probability,
                impact,
                mitigation_action,
                responsible_employee_id,
                due_date,
                status,
                post_probability,
                post_impact,
                effectiveness_result,
                assessment_date
            } = req.body;

            if (type !== undefined &&
                !['RISK', 'OPPORTUNITY'].includes(type)) {
                return res.status(400).json({
                    success: false,
                    message: 'type must be RISK or OPPORTUNITY'
                });
            }

            const validateScore = (value, field) => {
                if (
                    value !== undefined &&
                    value !== null &&
                    (Number(value) < 1 || Number(value) > 5)
                ) {
                    return `${field} must be between 1 and 5`;
                }
                return null;
            };

            const probabilityError =
                validateScore(probability, 'probability');

            if (probabilityError) {
                return res.status(400).json({
                    success: false,
                    message: probabilityError
                });
            }

            const impactError =
                validateScore(impact, 'impact');

            if (impactError) {
                return res.status(400).json({
                    success: false,
                    message: impactError
                });
            }

            const postProbabilityError =
                validateScore(post_probability, 'post_probability');

            if (postProbabilityError) {
                return res.status(400).json({
                    success: false,
                    message: postProbabilityError
                });
            }

            const postImpactError =
                validateScore(post_impact, 'post_impact');

            if (postImpactError) {
                return res.status(400).json({
                    success: false,
                    message: postImpactError
                });
            }

            const result = await pool.query(`
                UPDATE risks_opportunities
                SET
                    branch_id = COALESCE($1, branch_id),
                    title = COALESCE($2, title),
                    description = COALESCE($3, description),
                    type = COALESCE($4, type),
                    probability = COALESCE($5, probability),
                    impact = COALESCE($6, impact),
                    mitigation_action = COALESCE($7, mitigation_action),
                    responsible_employee_id = COALESCE($8, responsible_employee_id),
                    due_date = COALESCE($9, due_date),
                    status = COALESCE($10, status),
                    post_probability = COALESCE($11, post_probability),
                    post_impact = COALESCE($12, post_impact),
                    effectiveness_result = COALESCE($13, effectiveness_result),
                    assessment_date = COALESCE($14, assessment_date)
                WHERE risk_id = $15
                RETURNING
                    risk_id,
                    branch_id,
                    title,
                    description,
                    type,
                    probability,
                    impact,
                    risk_score,
                    mitigation_action,
                    responsible_employee_id,
                    due_date,
                    status,
                    post_probability,
                    post_impact,
                    post_risk_score,
                    effectiveness_result,
                    assessment_date,
                    created_by,
                    created_at,
                    updated_at
            `, [
                branch_id ?? null,
                title ?? null,
                description ?? null,
                type ?? null,
                probability ?? null,
                impact ?? null,
                mitigation_action ?? null,
                responsible_employee_id ?? null,
                due_date ?? null,
                status ?? null,
                post_probability ?? null,
                post_impact ?? null,
                effectiveness_result ?? null,
                assessment_date ?? null,
                req.params.id
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Risk or opportunity not found'
                });
            }

            res.json({
                success: true,
                message: 'Risk or opportunity updated successfully',
                risk_opportunity: result.rows[0]
            });

        } catch (error) {
            console.error('PATCH risk or opportunity error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to update risk or opportunity'
            });
        }
    }
);

module.exports = router;
